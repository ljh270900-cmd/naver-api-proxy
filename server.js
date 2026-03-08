/**
 * 네이버 커머스 API 고정 IP 프록시 서버
 * Railway.app에 배포하면 고정 outbound IP가 할당됩니다.
 */

import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';

const app = express();
app.use(express.json());

// CORS 설정
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Proxy-Secret');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// 환경 변수 (Railway에서 설정)
const NAVER_CLIENT_ID = process.env.NAVER_COMMERCE_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_COMMERCE_CLIENT_SECRET;
const PROXY_SECRET = process.env.PROXY_SECRET;

const NAVER_API_BASE = 'https://api.commerce.naver.com/external';

async function getNaverToken() {
  const timestamp = String(Date.now());
  const password = `${NAVER_CLIENT_ID}_${timestamp}`;
  
  const bcrypt = await import('bcryptjs');
  const hashed = bcrypt.hashSync(password, NAVER_CLIENT_SECRET);
  const clientSecretSign = Buffer.from(hashed).toString('base64');

  const params = new URLSearchParams({
    client_id: NAVER_CLIENT_ID,
    timestamp,
    client_secret_sign: clientSecretSign,
    grant_type: 'client_credentials',
    type: 'SELF',
  });

  const res = await fetch(`${NAVER_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`No access_token in response: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

// 인증 미들웨어
function authenticate(req, res, next) {
  const secret = req.headers['x-proxy-secret'];
  if (!PROXY_SECRET || secret !== PROXY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// 연결 테스트
app.post('/api/test', authenticate, async (req, res) => {
  try {
    await getNaverToken();
    res.json({ success: true, message: '연결 성공! 인증이 확인되었습니다.' });
  } catch (e) {
    res.json({ success: false, message: `연결 실패: ${e.message}` });
  }
});

/**
 * 24시간 윈도우 하나에 대해 변경 상품 주문 목록을 조회 (페이지네이션 포함)
 * 반환: productOrderId 배열
 */
async function fetchChangedOrderIds(token, from, to) {
  const allIds = [];
  let moreSequence = null;
  let currentFrom = from;

  while (true) {
    const params = new URLSearchParams({
      lastChangedFrom: currentFrom,
    });
    if (to) params.append('lastChangedTo', to);
    if (moreSequence) params.append('moreSequence', moreSequence);
    params.append('limitCount', '300');

    const url = `${NAVER_API_BASE}/v1/pay-order/seller/product-orders/last-changed-statuses?${params.toString()}`;
    console.log(`[fetchChangedOrderIds] GET ${url}`);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`last-changed-statuses failed: ${res.status} ${text}`);
    }

    const result = await res.json();
    const statuses = result.data?.lastChangeStatuses || [];

    for (const s of statuses) {
      if (s.productOrderId) {
        allIds.push(s.productOrderId);
      }
    }

    console.log(`[fetchChangedOrderIds] Got ${statuses.length} statuses, total so far: ${allIds.length}`);

    // 페이지네이션: more 객체가 있으면 계속
    if (result.data?.more) {
      currentFrom = result.data.more.moreFrom;
      moreSequence = result.data.more.moreSequence;
      await new Promise(r => setTimeout(r, 200));
    } else {
      break;
    }
  }

  return allIds;
}

/**
 * productOrderIds로 상세 내역 조회 (최대 300개씩 배치)
 */
async function fetchOrderDetails(token, productOrderIds) {
  const allOrders = [];

  for (let i = 0; i < productOrderIds.length; i += 300) {
    const batch = productOrderIds.slice(i, i + 300);

    const res = await fetch(`${NAVER_API_BASE}/v1/pay-order/seller/product-orders/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ productOrderIds: batch }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`product-orders/query failed: ${res.status} ${text}`);
    }

    const result = await res.json();
    const orders = result.data || [];
    allOrders.push(...orders);

    console.log(`[fetchOrderDetails] Batch ${Math.floor(i/300)+1}: ${orders.length} orders`);

    if (i + 300 < productOrderIds.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return allOrders;
}

// 주문 동기화
app.post('/api/sync', authenticate, async (req, res) => {
  try {
    const { fromDate, toDate } = req.body;
    const token = await getNaverToken();

    const endDateStr = toDate || new Date().toISOString().split('T')[0];
    const startDateStr = fromDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    console.log(`[sync] Date range: ${startDateStr} ~ ${endDateStr}`);

    // 24시간 단위로 윈도우를 나눠서 호출
    const allProductOrderIds = new Set();
    let currentDate = new Date(`${startDateStr}T00:00:00+09:00`);
    const endDate = new Date(`${endDateStr}T23:59:59+09:00`);

    while (currentDate < endDate) {
      const windowEnd = new Date(currentDate.getTime() + 24 * 60 * 60 * 1000);
      const effectiveEnd = windowEnd > endDate ? endDate : windowEnd;

      const fromStr = currentDate.toISOString().replace('Z', '+09:00');
      const toStr = effectiveEnd.toISOString().replace('Z', '+09:00');

      try {
        const ids = await fetchChangedOrderIds(token, fromStr, toStr);
        ids.forEach(id => allProductOrderIds.add(id));
      } catch (e) {
        console.error(`[sync] Error fetching window ${fromStr} ~ ${toStr}: ${e.message}`);
      }

      currentDate = windowEnd;
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`[sync] Total unique productOrderIds: ${allProductOrderIds.size}`);

    // 상세 내역 조회
    let orders = [];
    if (allProductOrderIds.size > 0) {
      orders = await fetchOrderDetails(token, [...allProductOrderIds]);
    }

    // 데이터 변환
    const mappedOrders = orders.map(item => {
      const order = item.order || {};
      const po = item.productOrder || {};

      return {
        orderId: order.orderId,
        productOrderId: po.productOrderId,
        orderDate: order.orderDate,
        paymentDate: order.paymentDate,
        productOrderStatus: po.productOrderStatus,
        totalPaymentAmount: po.totalPaymentAmount || 0,
        productName: po.productName,
        quantity: po.quantity || 1,
        unitPrice: po.unitPrice || 0,
        buyerName: order.ordererName,
        shippingFeeAmount: po.deliveryFeeAmount || 0,
        commissionAmount: po.commissionAmount || 0,
        cancelAmount: po.claimStatus?.includes('CANCEL') ? (po.totalPaymentAmount || 0) : 0,
        refundAmount: po.claimStatus?.includes('RETURN') ? (po.totalPaymentAmount || 0) : 0,
        sellerProductCode: po.sellerProductCode,
      };
    });

    console.log(`[sync] Returning ${mappedOrders.length} mapped orders`);

    res.json({
      success: true,
      orders: mappedOrders,
      totalFetched: mappedOrders.length,
    });
  } catch (e) {
    console.error(`[sync] Error: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 서버 IP 확인 (디버깅용)
app.get('/api/ip', async (req, res) => {
  try {
    const ipRes = await fetch('https://api.ipify.org?format=json');
    const data = await ipRes.json();
    res.json({ ip: data.ip, message: '이 IP를 네이버 API 센터에 등록하세요' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 헬스체크
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Naver API Proxy running on port ${PORT}`);
});
