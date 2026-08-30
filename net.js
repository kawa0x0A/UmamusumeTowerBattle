// ============================================================================
// net.js
//   PeerJS (WebRTC DataChannel) による 1 対 1 のオンライン対戦。
//
//   ・シグナリングは PeerJS の公開ブローカーを使うので自前サーバーは不要。
//   ・「部屋をつくった側」がホストで、物理演算はホストだけが回す (ホスト権威)。
//     当たり判定は画像から実行時に生成していて、ブラウザ差でわずかにズレうる。
//     両者で別々に物理を回すと必ず食い違うので、座標はホストが配って揃える。
//   ・WebRTC はセキュアコンテキスト限定。https:// か localhost で開く必要がある。
// ============================================================================

const Net = (() => {
  const PREFIX = 'umatower-v1-';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい I O 0 1 は除く
  const CODE_LEN = 4;
  const JOIN_TIMEOUT = 15000;

  let peer = null;
  let conn = null;
  let role = 'none';         // none | host | guest
  let cb = {};
  let joinTimer = 0;
  let closed = false;

  // WebRTC が使えるか (http:// の LAN アドレスなどでは使えない)
  function available() {
    return typeof window.Peer === 'function'
      && window.isSecureContext
      && typeof window.RTCPeerConnection === 'function';
  }

  function unavailableReason() {
    if (typeof window.Peer !== 'function') return 'オンライン対戦用のライブラリを読み込めませんでした。';
    if (!window.isSecureContext || typeof window.RTCPeerConnection !== 'function') {
      return 'オンライン対戦は https:// か localhost で開いたときだけ使えます（WebRTC の制限）。';
    }
    return '';
  }

  function randomCode() {
    let s = '';
    for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[(Math.random() * ALPHABET.length) | 0];
    return s;
  }

  function errorText(err) {
    switch (err && err.type) {
      case 'peer-unavailable':   return 'その合言葉の部屋が見つかりませんでした。';
      case 'unavailable-id':     return '部屋をつくれませんでした。もう一度お試しください。';
      case 'browser-incompatible': return 'このブラウザは WebRTC に対応していません。';
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':      return '接続サーバーにつながりませんでした。';
      case 'ssl-unavailable':    return 'https:// で開いてください。';
      default:                   return '通信エラーが発生しました' + (err && err.type ? ' (' + err.type + ')' : '') + '。';
    }
  }

  function fail(text) {
    clearTimeout(joinTimer);
    const wasOpen = !!(conn && conn.open);
    destroy();
    if (wasOpen) (cb.onClose || (() => {}))(text);
    else (cb.onError || (() => {}))(text);
  }

  function attach(c) {
    conn = c;
    c.on('open', () => {
      clearTimeout(joinTimer);
      (cb.onConnect || (() => {}))();
    });
    c.on('data', (d) => {
      if (!d || typeof d !== 'object') return;
      try { (cb.onMessage || (() => {}))(d); } catch (e) { console.error(e); }
    });
    c.on('close', () => {
      if (closed) return;
      conn = null;
      destroy();
      (cb.onClose || (() => {}))('相手との接続が切れました。');
    });
    c.on('error', () => fail('通信エラーが発生しました。'));
  }

  // 部屋をつくる。合言葉が決まったら cb.onCode(code) が呼ばれる。
  function host(callbacks) {
    destroy();
    cb = callbacks || {};
    role = 'host';
    closed = false;
    if (!available()) { role = 'none'; (cb.onError || (() => {}))(unavailableReason()); return; }

    let tries = 0;
    const attempt = () => {
      const code = randomCode();
      peer = new window.Peer(PREFIX + code, { debug: 0 });
      peer.on('open', () => (cb.onCode || (() => {}))(code));
      peer.on('connection', (c) => {
        if (conn) { c.close(); return; }   // 先に来た 1 人だけ
        attach(c);
      });
      peer.on('error', (err) => {
        // 合言葉がかぶったら引き直す
        if (err && err.type === 'unavailable-id' && tries++ < 6) {
          try { peer.destroy(); } catch (e) { /* noop */ }
          peer = null;
          attempt();
          return;
        }
        fail(errorText(err));
      });
    };
    attempt();
  }

  // 合言葉で参加する
  function join(code, callbacks) {
    destroy();
    cb = callbacks || {};
    role = 'guest';
    closed = false;
    if (!available()) { role = 'none'; (cb.onError || (() => {}))(unavailableReason()); return; }

    peer = new window.Peer(undefined, { debug: 0 });
    peer.on('open', () => {
      attach(peer.connect(PREFIX + code.toUpperCase(), { reliable: true, serialization: 'json' }));
      joinTimer = setTimeout(() => fail('部屋に接続できませんでした。合言葉を確認してください。'), JOIN_TIMEOUT);
    });
    peer.on('error', (err) => fail(errorText(err)));
  }

  function send(obj) {
    if (conn && conn.open) {
      try { conn.send(obj); } catch (e) { /* 切断直後は無視 */ }
    }
  }

  function destroy() {
    closed = true;
    clearTimeout(joinTimer);
    if (conn) { try { conn.close(); } catch (e) { /* noop */ } }
    if (peer) { try { peer.destroy(); } catch (e) { /* noop */ } }
    conn = null;
    peer = null;
    role = 'none';
  }

  // 自分から切る (相手には close イベントが飛ぶ)
  function close() {
    const cbs = cb;
    cb = {};
    destroy();
    return cbs;
  }

  return {
    host, join, send, close,
    available, unavailableReason,
    isOpen: () => !!(conn && conn.open),
    get role() { return role; },
  };
})();
