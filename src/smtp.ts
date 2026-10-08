// 极简 SMTP 客户端，运行于 Cloudflare Workers（cloudflare:sockets）
// 支持 465 直连 TLS(SSL) 与 587 STARTTLS，AUTH LOGIN，发送 HTML 邮件。
import { connect } from 'cloudflare:sockets';

export type SmtpSecurity = 'ssl' | 'starttls';

export type SmtpConfig = {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string; // 发信邮箱（也是 AUTH 登录名）
  pass: string; // QQ 邮箱为“授权码”
  fromName: string;
};

export type SendMailOptions = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

const te = new TextEncoder();
const td = new TextDecoder();

function b64FromBytes(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]);
  }
  return btoa(bin);
}
function b64FromText(s: string): string {
  return b64FromBytes(te.encode(s));
}

// 逐行读取 SMTP 回复（兼容多行 "250-..." 与终行 "250 ..."）
class LineReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = '';
  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader();
  }
  release(): void {
    this.reader.releaseLock();
  }
  private async pumpUntilLine(): Promise<string> {
    while (!this.buf.includes('\n')) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error('SMTP 连接已关闭');
      this.buf += td.decode(value, { stream: true });
    }
    const idx = this.buf.indexOf('\n');
    const line = this.buf.slice(0, idx).replace(/\r$/, '');
    this.buf = this.buf.slice(idx + 1);
    return line;
  }
  async readReply(): Promise<{ code: number; text: string }> {
    let line = await this.pumpUntilLine();
    let text = line;
    // 多行：第 4 个字符为 '-'，持续读到空格为止
    while (line.length >= 4 && line[3] === '-') {
      line = await this.pumpUntilLine();
      text += '\n' + line;
    }
    const code = parseInt(line.slice(0, 3), 10);
    return { code: Number.isNaN(code) ? -1 : code, text };
  }
}

type SocketLike = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close?: () => Promise<void> | void;
  startTls?: () => SocketLike;
};

const DEFAULT_TIMEOUT_MS = 15000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ehloDomain(cfg: SmtpConfig): string {
  const at = cfg.user.indexOf('@');
  return at >= 0 ? cfg.user.slice(at + 1) : 'bdrive.local';
}

export async function sendSmtp(cfg: SmtpConfig, mail: SendMailOptions): Promise<void> {
  if (!cfg.host || !cfg.user || !cfg.pass) throw new Error('SMTP 未完整配置');

  let socket: SocketLike;
  if (cfg.security === 'ssl') {
    socket = connect(
      { hostname: cfg.host, port: cfg.port },
      { secureTransport: 'on' } as unknown as SocketOptions
    ) as unknown as SocketLike;
  } else {
    socket = connect({ hostname: cfg.host, port: cfg.port }) as unknown as SocketLike;
  }

  const withDeadline = <T>(p: Promise<T>, label: string) => withTimeout(p, DEFAULT_TIMEOUT_MS, label);
  let writer = socket.writable.getWriter();
  let lr = new LineReader(socket.readable);

  async function raw(data: string): Promise<void> {
    await writer.write(te.encode(data));
  }
  async function expect(label: string, accept: number[]): Promise<string> {
    const r = await withDeadline(lr.readReply(), label);
    if (!accept.some((c) => String(r.code).startsWith(String(c)[0]))) {
      throw new Error(`${label} 失败：${r.code} ${r.text.split('\n')[0]}`);
    }
    return r.text;
  }
  async function cmd(data: string, label: string, accept: number[]): Promise<string> {
    await raw(data + '\r\n');
    return expect(label, accept);
  }

  try {
    // 初始问候
    await expect('连接', [220]);

    const domain = ehloDomain(cfg);
    if (cfg.security === 'starttls') {
      await cmd(`EHLO ${domain}`, 'EHLO', [250]);
      await cmd('STARTTLS', 'STARTTLS', [220]);
      // 升级到 TLS：先释放明文读写锁
      lr.release();
      await writer.close().catch(() => {});
      if (!socket.startTls) throw new Error('当前运行环境不支持 STARTTLS');
      socket = socket.startTls();
      writer = socket.writable.getWriter();
      lr = new LineReader(socket.readable);
      await cmd(`EHLO ${domain}`, 'EHLO(TLS)', [250]);
    } else {
      await cmd(`EHLO ${domain}`, 'EHLO', [250]);
    }

    // AUTH LOGIN
    await cmd('AUTH LOGIN', 'AUTH', [334]);
    await cmd(b64FromText(cfg.user), 'AUTH 用户', [334]);
    await cmd(b64FromText(cfg.pass), 'AUTH 授权码', [235]);

    // 信封
    await cmd(`MAIL FROM:<${cfg.user}>`, 'MAIL FROM', [250]);
    await cmd(`RCPT TO:<${mail.to}>`, 'RCPT TO', [250, 251]);

    // 信头与正文
    const toB64 = (s: string) => b64FromText(s);
    const subjectEnc = '=?UTF-8?B?' + toB64(mail.subject) + '?=';
    const fromEnc = '=?UTF-8?B?' + toB64(cfg.fromName || 'BDrive') + '?=';
    const htmlB64 = b64FromText(mail.html);
    const date = new Date().toUTCString();
    const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2, 10)}@${domain}>`;

    const headers =
      `From: ${fromEnc} <${cfg.user}>\r\n` +
      `To: <${mail.to}>\r\n` +
      `Subject: ${subjectEnc}\r\n` +
      `Date: ${date}\r\n` +
      `Message-ID: ${messageId}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `X-Mailer: BDrive Cloudflare Worker\r\n` +
      `\r\n`;

    await cmd('DATA', 'DATA', [354]);
    // 点号填充：以 . 开头的行需写成 ..
    const body = (headers + htmlB64).replace(/(^|\r\n)\./g, '$1..');
    await raw(body + '\r\n.\r\n');
    await expect('发送', [250]);

    await cmd('QUIT', 'QUIT', [221]).catch(() => {});
  } finally {
    try {
      await writer.close().catch(() => {});
    } catch {
      /* ignore */
    }
    try {
      await socket.close?.();
    } catch {
      /* ignore */
    }
  }
}
