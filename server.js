/**
 * 네이버 커머스 API 고정 IP 프록시 서버
 * Railway.app에 배포하면 고정 outbound IP가 할당됩니다.
 */

import express from 'express';
import fetch from 'node-fetch';

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
    throw new Error(`Token failed: ${text}`);
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
 * Date 객체를 네이버 API 요구 형식(KST ISO8601)으로 변환
 * 예: 2026-03-01T00:00:00.000+09:00
 */
function toKstIsoString(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.toISOString().slice(0, 23)}+09:00`;
}

/**
 * 네이버 응답에서 주문 배열을 추출
 * 응답 구조: { data: { contents: [...], pagination: {...} } }
 */
function extractOrderRows(result) {
  const data = result?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.contents)) return data.contents;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(result?.contents)) return result.contents;
  return [];
}

async function fetchOrdersByConditions(token, from, to) {
  const allOrders = [];
  let page = 1;
  const pageSize = 300;

  const productOrderStatuses = [
    "PAYMENT_WAITING",
    "PAYED",
    "DELIVERING",
    "DELIVERED",
    "PURCHASE_DECIDED",
    "EXCHANGED",
    "CANCELED",
    "CANCELED_BY_NOPAYMENT",
    "RETURNED",
  ];

  while (true) {
    const params = new URLSearchParams({
      from,
      to,
      rangeType: "PAYED_DATETIME",
      pageSize: String(pageSize),
      page: String(page),
      productOrderStatuses: productOrderStatuses.join(","),
    });

    const url = `${NAVER_API_BASE}/v1/pay-order/seller/product-orders?${params.toString()}`;
    console.log(`[fetchOrdersByConditions] GET ${url}`);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`product-orders failed: ${res.status} ${raw}`);
    }

    let result;
    try {
      result = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(`product-orders invalid json: ${raw?.slice?.(0, 500)}`);
    }

    const orders = extractOrderRows(result);
    allOrders.push(...orders);

    console.log(
      `[fetchOrdersByConditions] Page ${page}: ${orders.length} orders, total: ${allOrders.length}`,
    );

    // pagination 메타를 우선 사용
    const pagination = result?.data?.pagination;
    const totalPages = pagination?.totalPages ?? pagination?.totalPage;
    if (typeof totalPages === "number" && page >= totalPages) break;

    // 메타가 없으면 size 기반으로 탈출
    if (orders.length < pageSize) break;

    page += 1;
    if (page > 200) {
      throw new Error("Pagination safety limit exceeded (page > 200)");
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return allOrders;
}

// 주문 동기화
app.post('/api/sync', authenticate, async (req, res) => {
  try {
    const { fromDate, toDate } = req.body;
    const token = await getNaverToken();

    // 날짜 범위 결정
    const endDateStr = toDate || new Date().toISOString().split('T')[0];
    const startDateStr = fromDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    console.log(`[sync] Date range: ${startDateStr} ~ ${endDateStr}`);

    // 24시간 단위로 윈도우 분할 후 조건형 주문조회 호출
    const uniqueOrders = new Map();
    let currentDate = new Date(`${startDateStr}T00:00:00+09:00`);
    const endDate = new Date(`${endDateStr}T23:59:59+09:00`);

    let windowErrorCount = 0;
    let lastWindowError = null;

    while (currentDate < endDate) {
      const windowEnd = new Date(currentDate.getTime() + 24 * 60 * 60 * 1000);
      const effectiveEnd = windowEnd > endDate ? endDate : windowEnd;

      const fromStr = toKstIsoString(currentDate);
      const toStr = toKstIsoString(effectiveEnd);

      try {
        const ordersInWindow = await fetchOrdersByConditions(token, fromStr, toStr);

        for (const item of ordersInWindow) {
          const po = item?.productOrder || {};
          const key = po.productOrderId || item?.order?.orderId;
          if (key) uniqueOrders.set(key, item);
        }
      } catch (e) {
        windowErrorCount += 1;
        lastWindowError = e;
        console.error(`[sync] Error fetching window ${fromStr} ~ ${toStr}: ${e.message}`);
      }

      currentDate = windowEnd;
      await new Promise(r => setTimeout(r, 300));
    }

    const orders = [...uniqueOrders.values()];

    // 모든 윈도우가 실패했으면 오류로 반환 (0건 성공으로 숨기지 않음)
    if (orders.length === 0 && windowErrorCount > 0) {
      return res.status(500).json({
        success: false,
        error: `주문 조회 실패: ${windowErrorCount}개 구간에서 오류가 발생했습니다.`,
        detail: lastWindowError?.message,
      });
    }

    console.log(`[sync] Total unique orders: ${orders.length}`);

    // 프론트엔드에서 사용할 수 있도록 데이터 변환
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
app.list
