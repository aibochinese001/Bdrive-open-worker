import { md5 } from './lib';

// 易支付（EPay）对接：签名 / 下单参数 / 回调验签
// 规则：ksort → k=v& 拼接 → 去掉末尾 & → 拼接商户密钥 → MD5 小写

export type EpayConfig = {
  apiUrl: string;
  pid: string;
  key: string;
};

export function epaySign(params: Record<string, string | number>, key: string): string {
  const p: Record<string, string> = {};
  for (const k of Object.keys(params)) {
    if (k === 'sign' || k === 'sign_type') continue;
    const v = params[k];
    if (v === '' || v === null || v === undefined) continue;
    p[k] = String(v);
  }
  const sorted = Object.keys(p).sort();
  let str = '';
  for (const k of sorted) str += `${k}=${p[k]}&`;
  str = str.slice(0, -1);
  str += key;
  return md5(str).toLowerCase();
}

export function normalizeApiUrl(url: string): string {
  let u = url.trim();
  if (!u) return '';
  if (!/\/submit\.php$/i.test(u)) u = u.replace(/\/+$/, '') + '/submit.php';
  return u;
}

export type OrderParams = {
  pid: string;
  type: string;
  out_trade_no: string;
  notify_url: string;
  return_url: string;
  name: string;
  money: string;
  sign: string;
  sign_type: string;
  [k: string]: string;
};

export function buildOrderParams(
  cfg: EpayConfig,
  args: { type: string; outTradeNo: string; notifyUrl: string; returnUrl: string; name: string; money: string }
): OrderParams {
  const base: Record<string, string> = {
    pid: cfg.pid,
    type: args.type,
    out_trade_no: args.outTradeNo,
    notify_url: args.notifyUrl,
    return_url: args.returnUrl,
    name: args.name,
    money: args.money,
  };
  const sign = epaySign(base, cfg.key);
  return { ...base, sign, sign_type: 'MD5' } as OrderParams;
}

export function verifyCallbackSign(
  params: Record<string, string | number>,
  key: string,
  signToCheck: string
): boolean {
  const computed = epaySign(params, key);
  return computed.toLowerCase() === String(signToCheck).toLowerCase();
}

// 四种支付方式。gatewayType 为提交给易支付的 type 参数，
// 不同易支付服务商的数字人民币/USDT 通道代码可能不同，可在后台设置中覆盖。
export const PAY_METHODS = [
  { key: 'wxpay', label: '微信支付', defaultGatewayType: 'wxpay' },
  { key: 'alipay', label: '支付宝', defaultGatewayType: 'alipay' },
  { key: 'ecny', label: '数字人民币', defaultGatewayType: 'dcep' },
  { key: 'usdt', label: 'USDT', defaultGatewayType: 'usdt' },
] as const;

export type PayMethodKey = (typeof PAY_METHODS)[number]['key'];

export function isPayMethod(key: string): key is PayMethodKey {
  return PAY_METHODS.some((m) => m.key === key);
}
