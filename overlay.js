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
    // 先にキャプチャ画像を読み込み、その実ピクセルサイズから座標系を決める（build 参照）
    const DPR = window.devicePixelRatio || 1;
    const cropImg = new Image();
    cropImg.onload  = () => build(imgSrc, cropImg, DPR);
    cropImg.onerror = () => build(imgSrc, cropImg, DPR);
    cropImg.src = imgSrc;
  }

  function build(imgSrc, cropImg, DPR) {
    // キャプチャ画像の実ピクセルサイズ ÷ DPR ＝ ビューポートの正確な論理(CSS)サイズ。
    // これは getBoundingClientRect と 1:1 で対応するので、背景を等倍表示すれば枠と完全に一致する。
    // innerWidth/clientWidth を直接使うとスクロールバー幅やズームの分だけ右方向にずれる（従来の不具合原因）。
    const W = cropImg.naturalWidth  ? Math.round(cropImg.naturalWidth  / DPR) : document.documentElement.clientWidth;
    const H = cropImg.naturalHeight ? Math.round(cropImg.naturalHeight / DPR) : document.documentElement.clientHeight;
    // オーバーレイを実ビューポートぴったりに配置する
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
        <div id="guide">要素にホバーで自動検出 ／ ドラッグで手動選択 ／ スクロールで位置移動 ／ Esc でキャンセル</div>
      </div>`;

    const bgi   = shadow.getElementById('bgi');
    const cv    = shadow.getElementById('cv');
    const guide = shadow.querySelector('#guide');
    const ctx   = cv.getContext('2d');
    bgi.src     = imgSrc;
    cv.width    = W; cv.height = H;
    cv.style.cssText = `width:${W}px;height:${H}px`;

    // cropImg は build 冒頭で読み込み済み。以後の再キャプチャでは再描画のみ行う
    cropImg.onload = null;

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

    // ページ内の可視要素の辺（吸着先）と、角丸コーナー（手動選択の角追従用）を収集。
    // スクロールで撮影位置が変わったら再収集するので関数化しておく。
    // 角丸は当たり判定（elementFromPoint）だと、角丸で切り抜かれた透明部分に当たって拾えないため、
    // ここで各要素のborder-radiusを直接読み、角の座標＋半径のリストを作っておく。
    let xLines=[], yLines=[], roundedCorners=[];
    function collectSnapLines(){
      const xs=new Set(), ys=new Set();
      roundedCorners=[];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width<10 || r.height<10) continue;
        if (r.bottom<0 || r.right<0 || r.top>H || r.left>W) continue;
        xs.add(Math.round(r.left)); xs.add(Math.round(r.right));
        ys.add(Math.round(r.top));  ys.add(Math.round(r.bottom));
        const cs=getComputedStyle(el);
        const m=Math.min(r.width,r.height)/2;
        const tl=Math.min(parseFloat(cs.borderTopLeftRadius)||0,     m);
        const tr=Math.min(parseFloat(cs.borderTopRightRadius)||0,    m);
        const br=Math.min(parseFloat(cs.borderBottomRightRadius)||0, m);
        const bl=Math.min(parseFloat(cs.borderBottomLeftRadius)||0,  m);
        if (tl>0.5) roundedCorners.push({x:r.left,  y:r.top,    c:0, r:tl});  // c: 0=TL 1=TR 2=BR 3=BL
        if (tr>0.5) roundedCorners.push({x:r.right, y:r.top,    c:1, r:tr});
        if (br>0.5) roundedCorners.push({x:r.right, y:r.bottom, c:2, r:br});
        if (bl>0.5) roundedCorners.push({x:r.left,  y:r.bottom, c:3, r:bl});
        if (xs.size>4000) break;
      }
      xLines=[...xs]; yLines=[...ys];
    }
    collectSnapLines();

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

    // 検出した矩形と同じ範囲を占める要素の中から、実際の角丸を探す。
    // YouTubeサムネ等は最前面の<a>に角丸が無く、内側/外側のコンテナ（overflow:hidden）が
    // 丸めているため、ヒット要素だけ見ると直角になる。近い矩形の祖先・子孫も調べて最大半径を採用。
    function detectRadius(el, x, y, w, h) {
      const near=(a,b)=>Math.abs(a-b)<=4;
      const sameBox=r=>near(r.left,x)&&near(r.top,y)&&near(r.width,w)&&near(r.height,h);
      let best=[0,0,0,0];
      const consider=e=>{
        if (!e || e.nodeType!==1) return;
        let r; try { r=e.getBoundingClientRect(); } catch(_) { return; }
        if (!sameBox(r)) return;
        const rad=cornerRadii(e, w, h);
        best=best.map((v,i)=>Math.max(v,rad[i]));
      };
      consider(el);
      let p=el.parentElement, d=0;
      while (p && d<5) { consider(p); p=p.parentElement; d++; }   // 同じ矩形の祖先（overflow:hidden枠）
      const stack=[...el.children]; let n=0;
      while (stack.length && n<80) {                              // 同じ矩形を占める子孫（画像など）
        const c=stack.pop(); n++; consider(c);
        if (c.children && c.children.length) stack.push(...c.children);
      }
      return best;
    }

    // 任意の矩形の4隅それぞれについて、収集済みの角丸コーナーと一致するものがあれば採用する。
    // 手動でドラッグ・リサイズした選択でも、角が丸い要素の角に一致したところだけ丸くなる
    // （例：左は丸いサムネ、右は四角いテキスト → 左2角だけ丸く追従）。当たり判定に頼らないので確実。
    function radiiForRect(x, y, w, h) {
      const near=(a,b)=>Math.abs(a-b)<=8;
      const m=Math.min(w,h)/2;
      const corners=[[x,y,0],[x+w,y,1],[x+w,y+h,2],[x,y+h,3]];  // TL TR BR BL
      return corners.map(([cx,cy,ci])=>{
        let best=0;
        for (const rc of roundedCorners){
          if (rc.c===ci && near(rc.x,cx) && near(rc.y,cy)) best=Math.max(best, rc.r);
        }
        return Math.min(best, m);
      });
    }

    function detectElem(mx,my) {
      host.style.pointerEvents = 'none';
      const el = document.elementFromPoint(mx, my);
      host.style.pointerEvents = 'all';
      if (!el || el===document.documentElement || el===document.body) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return null;
      if (r.width >= W*0.98 && r.height >= H*0.98) return null;
      return {x:r.left, y:r.top, w:r.width, h:r.height, r:detectRadius(el, r.left, r.top, r.width, r.height)};
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
        : '要素にホバーで自動検出 ／ ドラッグで手動選択 ／ スクロールで位置移動 ／ Esc でキャンセル';
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
          prevRect={x:nx,y:ny,w,h};
          prevRect.r=radiiForRect(nx,ny,w,h);   // 移動先で角丸を取り直す
        }
        else {
          let x1=x,y1=y,x2=x+w,y2=y+h;
          if (activeH.includes('L')) { x1=x+dx; const s=snap1(x1,xLines); if(s!==null){x1=s;snapGuides.x=s;} x1=Math.min(x1,x2-10); }
          if (activeH.includes('R')) { x2=x+w+dx; const s=snap1(x2,xLines); if(s!==null){x2=s;snapGuides.x=s;} x2=Math.max(x2,x1+10); }
          if (activeH.includes('T')) { y1=y+dy; const s=snap1(y1,yLines); if(s!==null){y1=s;snapGuides.y=s;} y1=Math.min(y1,y2-10); }
          if (activeH.includes('B')) { y2=y+h+dy; const s=snap1(y2,yLines); if(s!==null){y2=s;snapGuides.y=s;} y2=Math.max(y2,y1+10); }
          prevRect=norm(x1,y1,x2,y2);
          prevRect.r=radiiForRect(prevRect.x,prevRect.y,prevRect.w,prevRect.h);   // リサイズ後の各角を判定
        }
        draw(); return;
      }
      if (dragStart) {
        let ex=mx, ey=my;
        snapGuides={x:null,y:null};
        const sx=snap1(ex,xLines), sy=snap1(ey,yLines);
        if (sx!==null){ ex=sx; snapGuides.x=sx; }
        if (sy!==null){ ey=sy; snapGuides.y=sy; }
        dragRect=norm(dragStart.x,dragStart.y,ex,ey);
        dragRect.r=radiiForRect(dragRect.x,dragRect.y,dragRect.w,dragRect.h);   // ドラッグ中も角丸を追従
        draw(); return;
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
      prevRect.r=radiiForRect(prevRect.x,prevRect.y,prevRect.w,prevRect.h);   // 確定時にも各角を判定
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

    // ── スクロールして撮影位置を変える ──
    // 起動時の1枚に固定されず、スクロールで別の場所を見てから選べるようにする。
    // スクロール中はオーバーレイを透明化して実ページを見せ、止まったら撮り直して選択モードへ戻す。
    let scrolling=false, scrollTimer=null;
    const scrollHint=document.createElement('div');
    Object.assign(scrollHint.style, {
      position:'fixed', top:'12px', left:'50%', transform:'translateX(-50%)',
      zIndex:'2147483647', padding:'6px 14px', borderRadius:'8px',
      background:'rgba(0,0,0,0.78)', color:'#fff',
      font:'600 12px -apple-system,"Hiragino Sans",sans-serif',
      pointerEvents:'none', opacity:'0', transition:'opacity 0.15s',
    });
    scrollHint.textContent='スクロール中… 止まると新しい位置で撮影モードに戻ります';
    document.documentElement.appendChild(scrollHint);

    function onWheel(e){ if (Math.abs(e.deltaY)>1 || Math.abs(e.deltaX)>1) enterScroll(); }
    function onScroll(){ if (scrolling){ clearTimeout(scrollTimer); scrollTimer=setTimeout(endScroll,260); } }

    function enterScroll(){
      if (!scrolling){
        scrolling=true;
        // 選択状態はスクロールで座標が変わるためリセット
        prevRect=hoverRect=dragRect=dragStart=activeH=null; snapGuides={x:null,y:null};
        host.style.opacity='0'; host.style.pointerEvents='none';
        scrollHint.style.opacity='1';
      }
      clearTimeout(scrollTimer); scrollTimer=setTimeout(endScroll,260);
    }
    function endScroll(){ reCapture(0); }
    function reCapture(attempt){
      chrome.runtime.sendMessage({type:'recapture'}, (resp)=>{
        if (chrome.runtime.lastError || !resp || !resp.dataUrl){
          if (attempt<3){ setTimeout(()=>reCapture(attempt+1), 500); return; }
          toast('画面の再取得に失敗しました', false); cleanup(); return;
        }
        cropImg.onload=()=>draw();     // 新しい画像を読み込んだら明るい部分も再描画
        cropImg.src=resp.dataUrl;
        bgi.src=resp.dataUrl;
        collectSnapLines();            // 新しい表示位置で吸着線を取り直す
        scrolling=false;
        host.style.opacity='1'; host.style.pointerEvents='all';
        scrollHint.style.opacity='0';
        setGuide(false); draw();       // まず暗い背景を描画（画像ロード後にonloadで再描画）
      });
    }
    window.addEventListener('wheel', onWheel, {passive:true, capture:true});
    window.addEventListener('scroll', onScroll, {passive:true, capture:true});

    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', onWheel, {capture:true});
      window.removeEventListener('scroll', onScroll, {capture:true});
      clearTimeout(scrollTimer);
      scrollHint.remove();
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
