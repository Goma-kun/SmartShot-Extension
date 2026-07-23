(function () {
  'use strict';
  if (document.getElementById('smartshot-host')) return;

  const host = document.createElement('div');
  host.id = 'smartshot-host';
  Object.assign(host.style, {
    position: 'fixed', inset: '0',
    zIndex: '2147483647',
    pointerEvents: 'all',
  });
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({mode: 'open'});

  chrome.storage.session.get(['smartshot_img'], ({smartshot_img}) => {
    if (!smartshot_img) { host.remove(); return; }
    init(smartshot_img);
  });

  function init(imgSrc) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const DPR = window.devicePixelRatio || 1;

    shadow.innerHTML = `
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        #wrap { position: fixed; inset: 0; overflow: hidden; }
        #bg { position: absolute; inset: 0; }
        #bg img { width: 100%; height: 100%; display: block; filter: brightness(0.5); }
        #cv { position: absolute; inset: 0; cursor: crosshair; }
        #guide {
          position: absolute; bottom: 0; left: 0; right: 0; height: 36px;
          background: rgba(0,0,0,0.65);
          color: rgba(255,255,255,0.85);
          font: 500 12px/36px -apple-system, "Hiragino Sans", sans-serif;
          text-align: center; pointer-events: none; letter-spacing: 0.02em;
        }
      </style>
      <div id="wrap">
        <div id="bg"><img id="bgi"></div>
        <canvas id="cv"></canvas>
        <div id="guide">要素にホバーで自動検出 ／ ドラッグで手動選択 ／ Esc でキャンセル</div>
      </div>`;

    const bgi   = shadow.getElementById('bgi');
    const cv    = shadow.getElementById('cv');
    const guide = shadow.querySelector('#guide');
    const ctx   = cv.getContext('2d');
    bgi.src     = imgSrc;
    cv.width    = W; cv.height = H;
    cv.style.cssText = `width:${W}px;height:${H}px`;

    const cropImg = new Image();
    cropImg.src = imgSrc;

    // ── 状態 ──
    let mode       = 'hover';  // hover | drag | preview
    let hoverRect  = null;
    let dragStart  = null;
    let dragRect   = null;
    let prevRect   = null;     // プレビュー矩形 {x,y,w,h}
    let activeH    = null;     // アクティブなハンドル名
    let hOrigin    = null;     // ハンドルドラッグ開始点
    let hOrigRect  = null;

    const EHIT = 10;           // ハンドル当たり判定 px

    function norm(x1,y1,x2,y2){ return {x:Math.min(x1,x2),y:Math.min(y1,y2),w:Math.abs(x2-x1),h:Math.abs(y2-y1)}; }

    function handles(r) {
      return {
        TL:{x:r.x,     y:r.y},      TR:{x:r.x+r.w,y:r.y},
        BL:{x:r.x,     y:r.y+r.h},  BR:{x:r.x+r.w,y:r.y+r.h},
        T: {x:r.x+r.w/2,y:r.y},     B: {x:r.x+r.w/2,y:r.y+r.h},
        L: {x:r.x,     y:r.y+r.h/2},R: {x:r.x+r.w, y:r.y+r.h/2},
      };
    }

    function hitHandle(mx,my,r) {
      for (const [n,p] of Object.entries(handles(r)))
        if (Math.abs(mx-p.x)<=EHIT && Math.abs(my-p.y)<=EHIT) return n;
      if (mx>=r.x&&mx<=r.x+r.w&&my>=r.y&&my<=r.y+r.h) return 'move';
      return null;
    }

    function detectElem(mx,my) {
      host.style.pointerEvents = 'none';
      const el = document.elementFromPoint(mx, my);
      host.style.pointerEvents = 'all';
      if (!el || el===document.documentElement || el===document.body) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return null;
      if (r.width >= W*0.98 && r.height >= H*0.98) return null;
      return {x:r.left, y:r.top, w:r.width, h:r.height};
    }

    // ── 描画 ──
    function draw() {
      ctx.clearRect(0,0,W,H);
      const r = prevRect || dragRect || hoverRect;
      if (!r || r.w<1 || r.h<1) {
        ctx.fillStyle='rgba(0,0,0,0.55)';
        ctx.fillRect(0,0,W,H);
        return;
      }
      // マスク4辺
      ctx.fillStyle='rgba(0,0,0,0.0)';  // bgが既に暗いので透明
      // 選択外を少し暗く
      ctx.fillStyle='rgba(0,0,0,0.3)';
      ctx.fillRect(0,0,W,r.y);
      ctx.fillRect(0,r.y,r.x,r.h);
      ctx.fillRect(r.x+r.w,r.y,W-r.x-r.w,r.h);
      ctx.fillRect(0,r.y+r.h,W,H-r.y-r.h);

      // 選択枠内：オリジナル画像を上書き描画（明るく）
      if (cropImg.complete) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x, r.y, r.w, r.h);
        ctx.clip();
        ctx.drawImage(cropImg, r.x*DPR, r.y*DPR, r.w*DPR, r.h*DPR, r.x, r.y, r.w, r.h);
        ctx.restore();
      }

      const isPrev = !!prevRect;
      const col = isPrev ? '#34d399' : '#00d4ff';

      // グロー
      ctx.strokeStyle = isPrev ? 'rgba(52,211,153,0.35)' : 'rgba(0,212,255,0.35)';
      ctx.lineWidth = 5;
      ctx.strokeRect(r.x-2,r.y-2,r.w+4,r.h+4);
      // 枠線
      ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x,r.y,r.w,r.h);

      // サイズバッジ
      const pw=Math.round(r.w*DPR), ph=Math.round(r.h*DPR);
      const label=`${pw} × ${ph}`;
      ctx.font='500 12px -apple-system,sans-serif';
      const tw=ctx.measureText(label).width;
      const bw=tw+20, bh=24;
      const bx=r.x+r.w/2-bw/2;
      const by=r.y>bh+14 ? r.y-bh-8 : r.y+r.h+8;
      ctx.fillStyle='rgba(0,0,0,0.8)';
      ctx.beginPath(); ctx.roundRect(bx,by,bw,bh,6); ctx.fill();
      ctx.fillStyle=col; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(label, bx+bw/2, by+bh/2);

      // ハンドル（プレビュー時）
      if (isPrev) {
        for (const pt of Object.values(handles(r))) {
          ctx.beginPath(); ctx.arc(pt.x,pt.y,5,0,Math.PI*2);
          ctx.fillStyle='#34d399'; ctx.fill();
          ctx.strokeStyle='rgba(0,0,0,0.5)'; ctx.lineWidth=1; ctx.stroke();
        }
      }
    }

    const CURSOR_MAP = {TL:'nwse-resize',BR:'nwse-resize',TR:'nesw-resize',BL:'nesw-resize',T:'ns-resize',B:'ns-resize',L:'ew-resize',R:'ew-resize',move:'move'};

    function setCursor(mx,my) {
      if (!prevRect) { cv.style.cursor='crosshair'; return; }
      const h=hitHandle(mx,my,prevRect);
      cv.style.cursor = h ? (CURSOR_MAP[h]||'crosshair') : 'crosshair';
    }

    function setGuide(isPreview) {
      guide.textContent = isPreview
        ? 'ドラッグでリサイズ・移動 ／ クリックまたは Return で保存 ／ Esc で再選択'
        : '要素にホバーで自動検出 ／ ドラッグで手動選択 ／ Esc でキャンセル';
    }

    // ── マウスイベント ──
    cv.addEventListener('mousemove', e => {
      const mx=e.offsetX, my=e.offsetY;
      if (activeH) {
        const dx=mx-hOrigin.x, dy=my-hOrigin.y;
        let {x,y,w,h}=hOrigRect;
        if (activeH==='move') { prevRect={x:x+dx,y:y+dy,w,h}; }
        else {
          let x1=x,y1=y,x2=x+w,y2=y+h;
          if (activeH.includes('L')) x1=Math.min(x+dx,x2-10);
          if (activeH.includes('R')) x2=Math.max(x+w+dx,x1+10);
          if (activeH.includes('T')) y1=Math.min(y+dy,y2-10);
          if (activeH.includes('B')) y2=Math.max(y+h+dy,y1+10);
          prevRect=norm(x1,y1,x2,y2);
        }
        draw(); return;
      }
      if (dragStart) { dragRect=norm(dragStart.x,dragStart.y,mx,my); draw(); return; }
      if (prevRect) { setCursor(mx,my); return; }
      hoverRect=detectElem(mx,my);
      draw(); setCursor(mx,my);
    });

    cv.addEventListener('mousedown', e => {
      if (e.button!==0) return;
      const mx=e.offsetX, my=e.offsetY;
      if (prevRect) {
        const h=hitHandle(mx,my,prevRect);
        if (h) { activeH=h; hOrigin={x:mx,y:my}; hOrigRect={...prevRect}; }
        else { save(prevRect); }
        return;
      }
      dragStart={x:mx,y:my}; dragRect=null;
    });

    cv.addEventListener('mouseup', e => {
      if (e.button!==0) return;
      const mx=e.offsetX, my=e.offsetY;
      if (activeH) { activeH=hOrigin=hOrigRect=null; return; }
      if (!dragStart) return;
      const dx=mx-dragStart.x, dy=my-dragStart.y;
      if (Math.abs(dx)<5 && Math.abs(dy)<5) {
        if (hoverRect) { prevRect={...hoverRect}; hoverRect=null; dragStart=null; setGuide(true); draw(); }
        else { dragStart=null; }
        return;
      }
      prevRect=norm(dragStart.x,dragStart.y,mx,my);
      dragStart=dragRect=hoverRect=null;
      setGuide(true); draw();
    });

    // ── キーボード ──
    function onKey(e) {
      if (e.key==='Escape') {
        if (prevRect) { prevRect=null; setGuide(false); draw(); }
        else { cleanup(); }
        e.preventDefault(); e.stopPropagation();
      }
      if ((e.key==='Enter'||e.key==='Return') && prevRect) {
        save(prevRect); e.preventDefault();
      }
    }
    document.addEventListener('keydown', onKey, true);

    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
      host.remove();
    }

    // ── 保存 ──
    function save(r) {
      const pw=Math.round(r.w*DPR), ph=Math.round(r.h*DPR);
      if (pw<1||ph<1) return;
      const off=document.createElement('canvas');
      off.width=pw; off.height=ph;
      const octx=off.getContext('2d');
      octx.drawImage(cropImg, r.x*DPR, r.y*DPR, pw, ph, 0, 0, pw, ph);
      const ts=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
      chrome.runtime.sendMessage({type:'download', dataUrl:off.toDataURL('image/png'), filename:`SmartShot_${ts}.png`});
      // 確定と同時にクリップボードへもコピー（失敗してもPNG保存は済んでいる）
      try {
        const blob = new Promise(res => off.toBlob(res, 'image/png'));
        navigator.clipboard.write([new ClipboardItem({'image/png': blob})]).catch(()=>{});
      } catch (_) {}
      cleanup();
    }

    // 初期描画（全面暗転）
    ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.fillRect(0,0,W,H);
  }
})();
