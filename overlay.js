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
    // getBoundingClientRect と同じ座標系（縦スクロールバーを除いた表示領域）に合わせる。
    // innerWidth を使うとスクロールバー幅ぶん背景が横に伸び、右側の要素ほど枠がずれる。
    const W = document.documentElement.clientWidth;
    const H = document.documentElement.clientHeight;
    const DPR = window.devicePixelRatio || 1;
    // オーバーレイもスクロールバーを覆わないよう、表示領域ぴったりに配置する
    Object.assign(host.style, {
      top:'0', left:'0', right:'auto', bottom:'auto',
      width:W+'px', height:H+'px',
    });

    shadow.innerHTML = `
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        #wrap { position: absolute; inset: 0; overflow: hidden; }
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
    const SNAP = 8;            // エッジスナップ距離 px
    let snapGuides = {x:null, y:null};

    // ページ内の可視要素の辺を収集（ドラッグ・リサイズ・移動時のスナップ先）
    let xLines=[], yLines=[];
    (function collectSnapLines(){
      const xs=new Set(), ys=new Set();
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width<10 || r.height<10) continue;
        if (r.bottom<0 || r.right<0 || r.top>H || r.left>W) continue;
        xs.add(Math.round(r.left)); xs.add(Math.round(r.right));
        ys.add(Math.round(r.top));  ys.add(Math.round(r.bottom));
        if (xs.size>4000) break;
      }
      xLines=[...xs]; yLines=[...ys];
    })();

    function snap1(v, lines){
      let best=null, bd=SNAP+1;
      for (const l of lines){ const d=Math.abs(v-l); if (d<bd){ bd=d; best=l; } }
      return best;
    }

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

    // CSS座標→キャプチャ画像の実ピクセルへの倍率（DPR固定ではなく実画像から算出）
    function imgScale() {
      const nw=cropImg.naturalWidth, nh=cropImg.naturalHeight;
      return (nw && nh) ? {x:nw/W, y:nh/H} : {x:DPR, y:DPR};
    }

    // 要素の角丸半径（4隅）を取得。各辺の半分にクランプ
    function cornerRadii(el, w, h) {
      const cs=getComputedStyle(el);
      const p=v=>{ const n=parseFloat(v); return isNaN(n)?0:n; };
      const m=Math.min(w,h)/2;
      return [
        Math.min(p(cs.borderTopLeftRadius),     m),
        Math.min(p(cs.borderTopRightRadius),    m),
        Math.min(p(cs.borderBottomRightRadius), m),
        Math.min(p(cs.borderBottomLeftRadius),  m),
      ];
    }

    function detectElem(mx,my) {
      host.style.pointerEvents = 'none';
      const el = document.elementFromPoint(mx, my);
      host.style.pointerEvents = 'all';
      if (!el || el===document.documentElement || el===document.body) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return null;
      if (r.width >= W*0.98 && r.height >= H*0.98) return null;
      return {x:r.left, y:r.top, w:r.width, h:r.height, r:cornerRadii(el, r.width, r.height)};
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

      // 角丸情報。要素検出時のみ半径を持つ（手動ドラッグは直角）
      const rad = r.r || [0,0,0,0];
      const hasR = rad.some(v => v > 0.5);
      const pathRect = (x,y,w,h,extra=0) => {
        ctx.beginPath();
        if (hasR) ctx.roundRect(x, y, w, h, rad.map(v => Math.max(0, v+extra)));
        else ctx.rect(x, y, w, h);
      };

      // 選択枠内：オリジナル画像を上書き描画（明るく）
      if (cropImg.complete) {
        const s = imgScale();
        ctx.save();
        pathRect(r.x, r.y, r.w, r.h);
        ctx.clip();
        ctx.drawImage(cropImg, r.x*s.x, r.y*s.y, r.w*s.x, r.h*s.y, r.x, r.y, r.w, r.h);
        ctx.restore();
      }

      const isPrev = !!prevRect;
      const col = isPrev ? '#34d399' : '#00d4ff';

      // グロー
      ctx.strokeStyle = isPrev ? 'rgba(52,211,153,0.35)' : 'rgba(0,212,255,0.35)';
      ctx.lineWidth = 5;
      pathRect(r.x-2, r.y-2, r.w+4, r.h+4, 2); ctx.stroke();
      // 枠線
      ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      pathRect(r.x, r.y, r.w, r.h); ctx.stroke();

      // サイズバッジ
      const bs=imgScale();
      const pw=Math.round(r.w*bs.x), ph=Math.round(r.h*bs.y);
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

      // スナップガイド線（吸着中の辺を表示）
      if (snapGuides.x!==null || snapGuides.y!==null) {
        ctx.save();
        ctx.strokeStyle='rgba(255,86,180,0.9)'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
        if (snapGuides.x!==null){ ctx.beginPath(); ctx.moveTo(snapGuides.x+0.5,0); ctx.lineTo(snapGuides.x+0.5,H); ctx.stroke(); }
        if (snapGuides.y!==null){ ctx.beginPath(); ctx.moveTo(0,snapGuides.y+0.5); ctx.lineTo(W,snapGuides.y+0.5); ctx.stroke(); }
        ctx.restore();
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
        ? '辺にピタッと吸着 ／ Return またはクリックでコピー＆保存 ／ Esc で再選択'
        : '要素にホバーで自動検出 ／ ドラッグで手動選択 ／ Esc でキャンセル';
    }

    // ── マウスイベント ──
    cv.addEventListener('mousemove', e => {
      const mx=e.offsetX, my=e.offsetY;
      if (activeH) {
        const dx=mx-hOrigin.x, dy=my-hOrigin.y;
        let {x,y,w,h}=hOrigRect;
        snapGuides={x:null,y:null};
        if (activeH==='move') {
          let nx=x+dx, ny=y+dy;
          // 移動中は左右/上下の辺、両方をスナップ対象にする
          const sl=snap1(nx,xLines), sr=snap1(nx+w,xLines);
          const st=snap1(ny,yLines), sb=snap1(ny+h,yLines);
          if (sl!==null){ nx=sl; snapGuides.x=sl; } else if (sr!==null){ nx=sr-w; snapGuides.x=sr; }
          if (st!==null){ ny=st; snapGuides.y=st; } else if (sb!==null){ ny=sb-h; snapGuides.y=sb; }
          prevRect={x:nx,y:ny,w,h, r:hOrigRect.r};
        }
        else {
          let x1=x,y1=y,x2=x+w,y2=y+h;
          if (activeH.includes('L')) { x1=x+dx; const s=snap1(x1,xLines); if(s!==null){x1=s;snapGuides.x=s;} x1=Math.min(x1,x2-10); }
          if (activeH.includes('R')) { x2=x+w+dx; const s=snap1(x2,xLines); if(s!==null){x2=s;snapGuides.x=s;} x2=Math.max(x2,x1+10); }
          if (activeH.includes('T')) { y1=y+dy; const s=snap1(y1,yLines); if(s!==null){y1=s;snapGuides.y=s;} y1=Math.min(y1,y2-10); }
          if (activeH.includes('B')) { y2=y+h+dy; const s=snap1(y2,yLines); if(s!==null){y2=s;snapGuides.y=s;} y2=Math.max(y2,y1+10); }
          prevRect=norm(x1,y1,x2,y2); prevRect.r=hOrigRect.r;
        }
        draw(); return;
      }
      if (dragStart) {
        let ex=mx, ey=my;
        snapGuides={x:null,y:null};
        const sx=snap1(ex,xLines), sy=snap1(ey,yLines);
        if (sx!==null){ ex=sx; snapGuides.x=sx; }
        if (sy!==null){ ey=sy; snapGuides.y=sy; }
        dragRect=norm(dragStart.x,dragStart.y,ex,ey); draw(); return;
      }
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
      if (activeH) { activeH=hOrigin=hOrigRect=null; snapGuides={x:null,y:null}; draw(); return; }
      if (!dragStart) return;
      const dx=mx-dragStart.x, dy=my-dragStart.y;
      if (Math.abs(dx)<5 && Math.abs(dy)<5) {
        if (hoverRect) { prevRect={...hoverRect}; hoverRect=null; dragStart=null; setGuide(true); draw(); }
        else { dragStart=null; }
        return;
      }
      // ドラッグ終点にスナップを適用してからプレビュー確定
      let ex=mx, ey=my;
      const sx=snap1(ex,xLines), sy=snap1(ey,yLines);
      if (sx!==null) ex=sx;
      if (sy!==null) ey=sy;
      prevRect=norm(dragStart.x,dragStart.y,ex,ey);
      dragStart=dragRect=hoverRect=null;
      snapGuides={x:null,y:null};
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

    // ── トースト通知 ──
    function toast(msg, ok) {
      const t=document.createElement('div');
      Object.assign(t.style, {
        position:'fixed', left:'50%', bottom:'48px', transform:'translateX(-50%)',
        zIndex:'2147483647', padding:'10px 18px', borderRadius:'8px',
        background: ok ? 'rgba(16,185,129,0.95)' : 'rgba(239,68,68,0.95)',
        color:'#fff', font:'600 13px -apple-system,"Hiragino Sans",sans-serif',
        boxShadow:'0 4px 20px rgba(0,0,0,0.4)', pointerEvents:'none',
        opacity:'0', transition:'opacity 0.15s',
      });
      t.textContent=msg;
      document.documentElement.appendChild(t);
      requestAnimationFrame(()=>{ t.style.opacity='1'; });
      setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.remove(),200); }, 1600);
    }

    // ── 保存＆コピー ──
    function save(r) {
      const s=imgScale();
      const pw=Math.round(r.w*s.x), ph=Math.round(r.h*s.y);
      if (pw<1||ph<1) return;
      const off=document.createElement('canvas');
      off.width=pw; off.height=ph;
      const octx=off.getContext('2d');
      // 角丸要素は角丸のまま切り抜く（PNGの四隅は透明になる）
      const rad=(r.r||[0,0,0,0]).map(v=>v*s.x);
      if (rad.some(v=>v>0.5)) { octx.beginPath(); octx.roundRect(0,0,pw,ph,rad); octx.clip(); }
      octx.drawImage(cropImg, r.x*s.x, r.y*s.y, pw, ph, 0, 0, pw, ph);

      // クリップボードへコピー。navigator.clipboard.write は「その文書がフォーカスを
      // 持っている」ことが必要なので、オーバーレイを消す前・ユーザー操作の同期文脈で実行する。
      const ts=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
      const finish = (copied) => {
        chrome.runtime.sendMessage({type:'download', dataUrl:off.toDataURL('image/png'), filename:`SmartShot_${ts}.png`});
        toast(copied ? 'コピーしました（⌘Vで貼り付け）／PNGも保存' : 'PNG保存のみ（コピー失敗）', copied);
        cleanup();
      };

      let done=false;
      const settle=(copied)=>{ if(done) return; done=true; finish(copied); };

      try {
        off.toBlob((blob)=>{
          if (!blob) { settle(false); return; }
          try {
            navigator.clipboard.write([new ClipboardItem({'image/png': blob})])
              .then(()=>settle(true))
              .catch(()=>settle(false));
          } catch(_) { settle(false); }
        }, 'image/png');
      } catch(_) { settle(false); }

      // 念のためのフォールバック（toBlobのコールバックが来ない環境向け）
      setTimeout(()=>settle(false), 1500);
    }

    // 初期描画（全面暗転）
    ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.fillRect(0,0,W,H);
  }
})();
