// BOXIV-only: バッテリー劣化診断フォームのページ HTML。
// デザインは lightning.boxiv.co.jp 準拠（白基調 / #1a1a1a / ピル型ボタン / Noto Sans JP / 角丸カード）。
// ファーストビュー = 動画背景（街を走るテスラ→側面→バッテリー可視化）＋
// 字幕シーケンス＋バッテリーゲージのベクターアニメ＋CTA。
// 動画は R2 (`/media/video/diagnosis-hero.mp4`) から配信。reduced-motion / 動画エラー時は
// ポスター静止画＋完成状態に即フォールバックする。

const HERO_VIDEO = '/media/video/diagnosis-hero.mp4';
const HERO_POSTER = '/media/video/diagnosis-hero-poster.jpg';

// 公式ロゴ（Figma「Lightning_logo_str」エクスポート・稲妻はブランドグラデーション）
function logoSvg(textColor: string, id: string): string {
  return `<svg viewBox="0 0 400 98" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="BOXIV Lightning">
<path d="M62.8457 43.8616H37.3991V1.7233C37.3991 0.0236062 35.2074 -0.645255 34.2681 0.763288L0.297516 51.463C-0.469562 52.604 0.34448 54.1463 1.71426 54.1463H27.1609V96.2767C27.1609 97.9764 29.3526 98.6452 30.2918 97.2367L64.2625 46.537C65.0295 45.396 64.2155 43.8537 62.8457 43.8537V43.8616Z" fill="url(#lg_${id})"/>
<path d="M98.2017 65.1864H115.868C116.58 65.1864 117.05 65.7609 116.925 66.477L116.165 70.8049C116.04 71.521 115.367 72.0954 114.655 72.0954H89.1533C88.441 72.0954 87.9714 71.521 88.0966 70.8049L96.3388 23.7957C96.464 23.0797 97.1372 22.5052 97.8495 22.5052H103.117C103.83 22.5052 104.299 23.0797 104.174 23.7957L97.1372 63.8959C97.012 64.612 97.4894 65.1864 98.1939 65.1864H98.2017Z" fill="${textColor}"/>
<path d="M137.573 28.9656H132.11C131.397 28.9656 130.928 28.3912 131.053 27.6751L131.844 23.1505C131.969 22.4344 132.642 21.86 133.354 21.86H138.818C139.53 21.86 140 22.4344 139.874 23.1505L139.084 27.6751C138.959 28.3912 138.286 28.9656 137.573 28.9656ZM129.879 72.1033H124.674C123.962 72.1033 123.492 71.5288 123.617 70.8128L129.746 35.8746C129.871 35.1585 130.544 34.5841 131.257 34.5841H136.462C137.174 34.5841 137.644 35.1585 137.518 35.8746L131.39 70.8128C131.264 71.5288 130.591 72.1033 129.879 72.1033Z" fill="${textColor}"/>
<path d="M155.717 81.1368C163.873 81.1368 166.699 75.6443 167.481 71.1905L167.591 70.5609C167.787 69.4514 166.589 68.8534 165.626 69.5931C163.192 71.4659 159.819 73.0003 155.662 73.0003C145.902 73.0003 142.262 65.8946 144.336 54.0833C146.269 43.0432 151.921 33.5454 163.677 33.5454C175.434 33.5454 170.354 34.6864 172.413 36.4726C173.078 37.0471 174.252 36.6143 174.589 35.67C174.925 34.7257 174.597 35.6464 174.604 35.6306C174.823 35.0169 175.434 34.5762 176.052 34.5762H180.475C181.242 34.5762 181.719 35.2451 181.5 36.0083C181.023 37.7159 180.459 40.0845 180.177 41.6819L174.839 72.0954C172.765 83.9146 163.02 87.4635 154.606 87.4635C146.191 87.4635 145.768 86.5979 141.917 85.1579C141.33 84.9375 141.088 84.2765 141.362 83.6313L143.013 79.7204C143.334 78.965 144.219 78.5401 144.884 78.8312C147.944 80.1611 152.062 81.1447 155.717 81.1447V81.1368ZM171.27 50.3377C171.606 48.402 171.896 46.4583 171.904 44.8373C171.904 44.6327 171.857 44.436 171.755 44.2629C170.565 42.2642 167.943 40.0687 163.881 40.0687C156.946 40.0687 153.666 45.9468 152.257 53.9496C150.848 61.9523 152.312 66.477 158.41 66.477C164.507 66.477 167.372 63.054 169.031 60.4808C169.094 60.3864 169.141 60.2841 169.18 60.1818C169.634 58.9385 170.096 56.9713 170.401 55.2401L171.262 50.3298L171.27 50.3377Z" fill="${textColor}"/>
<path d="M212.825 33.868C222.398 33.868 223.901 39.935 222.719 46.6551L218.484 70.8049C218.359 71.521 217.686 72.0954 216.974 72.0954H211.901C211.189 72.0954 210.72 71.521 210.845 70.8049L214.743 48.5908C215.58 43.8144 214.602 40.2576 209.397 40.2576C204.192 40.2576 202.266 41.8156 199.886 44.0032C199.628 44.2393 199.456 44.554 199.401 44.8767L194.854 70.8049C194.728 71.521 194.055 72.0954 193.343 72.0954H188.138C187.425 72.0954 186.956 71.521 187.081 70.8049L195.652 21.9387C195.762 21.3013 196.325 20.7583 196.975 20.6639L202.313 19.8849C203.111 19.7668 203.698 20.3727 203.565 21.1596L201.006 35.7723C200.826 36.811 201.875 37.4248 202.822 36.8425C205.616 35.127 209.24 33.8759 212.833 33.8759L212.825 33.868Z" fill="${textColor}"/>
<path d="M246.279 67.6416L245.692 71.0016C245.575 71.6862 244.941 72.2528 244.252 72.2921L241.912 72.418C235.493 72.7406 231.791 70.4193 233.004 63.5104L236.706 42.3901C236.832 41.674 236.354 41.0996 235.65 41.0996H232.307C231.595 41.0996 231.125 40.5251 231.251 39.8091L231.861 36.3231C231.986 35.607 232.66 35.0326 233.372 35.0326H236.714C237.426 35.0326 238.1 34.4582 238.225 33.7421L239.321 27.5099C239.422 26.9197 239.916 26.4004 240.51 26.2587L245.747 24.9761C246.592 24.7715 247.273 25.3853 247.125 26.2272L245.81 33.7342C245.684 34.4503 246.162 35.0247 246.866 35.0247H252.071C252.784 35.0247 253.253 35.5992 253.128 36.3152L252.518 39.8012C252.392 40.5173 251.719 41.0917 251.007 41.0917H245.802C245.089 41.0917 244.416 41.6661 244.291 42.3822L241.097 60.591C240.33 64.9818 241.05 66.3353 244.33 66.3353H245.23C245.943 66.3353 246.412 66.9097 246.287 67.6258L246.279 67.6416Z" fill="${textColor}"/>
<path d="M268.094 35.0405C268.164 35.5598 268.219 36.1343 268.258 36.7008C268.313 37.6058 269.323 37.9992 270.152 37.4326C273.127 35.4103 277.236 33.8837 281.04 33.8837C290.676 33.8837 292.178 39.9507 291.004 46.6708L286.77 70.8206C286.645 71.5367 285.971 72.1111 285.259 72.1111H280.117C279.404 72.1111 278.935 71.5367 279.06 70.8206L282.958 48.6066C283.795 43.8301 282.817 40.2733 277.612 40.2733C272.407 40.2733 270.512 41.8156 268.102 43.8852C265.691 45.9547 267.632 44.4517 267.569 44.7901L263.006 70.8206C262.881 71.5367 262.208 72.1111 261.495 72.1111H256.353C255.64 72.1111 255.171 71.5367 255.296 70.8206L260.219 42.7284C260.595 40.5802 260.822 38.3061 260.767 36.3231C260.713 34.3401 261.37 34.891 262.122 34.7887L266.849 34.1591C267.483 34.0726 268.008 34.4503 268.094 35.0562V35.0405Z" fill="${textColor}"/>
<path d="M312.537 28.9656H307.074C306.362 28.9656 305.892 28.3912 306.017 27.6751L306.808 23.1505C306.933 22.4344 307.606 21.86 308.318 21.86H313.782C314.494 21.86 314.964 22.4344 314.839 23.1505L314.048 27.6751C313.923 28.3912 313.25 28.9656 312.537 28.9656ZM304.843 72.1033H299.638C298.926 72.1033 298.456 71.5288 298.581 70.8128L304.71 35.8746C304.835 35.1585 305.508 34.5841 306.221 34.5841H311.426C312.138 34.5841 312.608 35.1585 312.483 35.8746L306.354 70.8128C306.229 71.5288 305.555 72.1033 304.843 72.1033Z" fill="${textColor}"/>
<path d="M331.3 35.0405C331.37 35.5598 331.425 36.1343 331.464 36.7008C331.519 37.6058 332.528 37.9992 333.358 37.4326C336.333 35.4103 340.442 33.8837 344.246 33.8837C353.881 33.8837 355.384 39.9507 354.21 46.6708L349.976 70.8206C349.85 71.5367 349.177 72.1111 348.465 72.1111H343.322C342.61 72.1111 342.14 71.5367 342.266 70.8206L346.164 48.6066C347.001 43.8301 346.023 40.2733 340.818 40.2733C335.612 40.2733 333.718 41.8156 331.307 43.8852C328.897 45.9547 330.838 44.4517 330.775 44.7901L326.212 70.8206C326.087 71.5367 325.413 72.1111 324.701 72.1111H319.559C318.846 72.1111 318.377 71.5367 318.502 70.8206L323.425 42.7284C323.801 40.5802 324.028 38.3061 323.973 36.3231C323.95 35.5913 324.576 34.891 325.327 34.7887L330.055 34.1591C330.689 34.0726 331.213 34.4503 331.3 35.0562V35.0405Z" fill="${textColor}"/>
<path d="M374.17 81.1368C382.326 81.1368 385.152 75.6443 385.934 71.1905L386.044 70.5609C386.24 69.4514 385.042 68.8534 384.079 69.5931C381.645 71.4659 378.271 73.0003 374.115 73.0003C364.354 73.0003 360.715 65.8946 362.789 54.0833C364.722 43.0432 370.374 33.5454 382.13 33.5454C393.887 33.5454 388.807 34.6864 390.866 36.4726C391.531 37.0471 392.705 36.6143 393.042 35.67C393.378 34.7257 393.049 35.6464 393.057 35.6306C393.276 35.0169 393.887 34.5762 394.505 34.5762H398.928C399.695 34.5762 400.172 35.2451 399.953 36.0083C399.476 37.7159 398.912 40.0845 398.63 41.6819L393.292 72.0954C391.218 83.9146 381.473 87.4635 373.058 87.4635C364.644 87.4635 364.221 86.5979 360.37 85.1579C359.783 84.9375 359.541 84.2765 359.815 83.6313L361.466 79.7204C361.787 78.965 362.672 78.5401 363.337 78.8312C366.397 80.1611 370.515 81.1447 374.17 81.1447V81.1368ZM389.723 50.3377C390.059 48.402 390.349 46.4583 390.357 44.8373C390.357 44.6327 390.31 44.436 390.208 44.2629C389.018 42.2642 386.396 40.0687 382.334 40.0687C375.399 40.0687 372.119 45.9468 370.71 53.9496C369.301 61.9523 370.765 66.477 376.862 66.477C382.96 66.477 385.825 63.054 387.484 60.4808C387.547 60.3864 387.594 60.2841 387.633 60.1818C388.087 58.9385 388.549 56.9713 388.854 55.2401L389.715 50.3298L389.723 50.3377Z" fill="${textColor}"/>
<defs><linearGradient id="lg_${id}" x1="32.28" y1="98" x2="32.28" y2="0" gradientUnits="userSpaceOnUse"><stop stop-color="#5E6FFF"/><stop offset="0.9" stop-color="#55D6FF"/></linearGradient></defs>
</svg>`;
}

export function renderFormPage(liffId: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>バッテリー劣化 無料診断｜BOXIV Lightning</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  :root{
    --ink:#1a1a1a; --text:#333; --mute:#6b6b6b; --line:#e3e3e5; --surface:#f5f5f7;
    --bg:#fff; --green:#2fd06f; --err:#c62828;
  }
  *{ box-sizing:border-box; margin:0; padding:0; }
  html{ scroll-behavior:smooth; }
  body{ background:var(--bg); color:var(--text);
        font-family:"Noto Sans JP","Hiragino Kaku Gothic ProN","Hiragino Sans",sans-serif;
        font-size:15px; line-height:1.8; -webkit-font-smoothing:antialiased; }

  /* ───────── HERO ───────── */
  #hero{ position:relative; height:100svh; min-height:560px; overflow:hidden; background:#0b1530; }
  #hero video, #hero .poster{
    position:absolute; inset:0; width:100%; height:100%; object-fit:cover; object-position:center;
  }
  #hero .poster{ background:url('${HERO_POSTER}') center/cover no-repeat; display:none; }
  #hero.no-video video{ display:none; }
  #hero.no-video .poster{ display:block; }
  .scrim{ position:absolute; inset:0; pointer-events:none;
    background:linear-gradient(180deg, rgba(6,12,30,.5) 0%, rgba(6,12,30,0) 30%, rgba(6,12,30,0) 55%, rgba(6,12,30,.72) 100%); }
  .hbrand{ position:absolute; top:calc(env(safe-area-inset-top, 0px) + 18px); left:20px; width:128px; z-index:3; }
  .hbrand svg{ width:100%; height:auto; display:block; }

  .cap{
    position:absolute; left:24px; right:24px; bottom:19%; z-index:2;
    color:#fff; font-size:22px; font-weight:700; letter-spacing:.02em; line-height:1.6;
    text-shadow:0 2px 18px rgba(0,10,30,.55);
    opacity:0; transform:translateY(14px); transition:opacity .7s ease, transform .7s ease;
    pointer-events:none;
  }
  .cap.show{ opacity:1; transform:none; }

  #finale{
    position:absolute; inset:auto 0 0 0; z-index:4; padding:0 24px calc(env(safe-area-inset-bottom, 0px) + 34px);
    display:flex; flex-direction:column; align-items:flex-start; gap:14px;
    opacity:0; transform:translateY(22px); transition:opacity .8s ease, transform .8s ease;
    pointer-events:none;
  }
  #finale.show{ opacity:1; transform:none; pointer-events:auto; }
  .batt-row{ display:flex; align-items:center; gap:14px; }
  /* バッテリーが車体側面に「出現→拡大」するエントランス */
  #finale.show .batt-row{ animation:battpop .9s cubic-bezier(.18,.85,.3,1.15) both .15s; }
  @keyframes battpop{
    0%{ opacity:0; transform:scale(.45) translateY(30px); filter:drop-shadow(0 0 0 rgba(76,227,138,0)); }
    60%{ opacity:1; }
    100%{ opacity:1; transform:none; filter:drop-shadow(0 0 22px rgba(76,227,138,.45)); }
  }
  @media (prefers-reduced-motion: reduce){ #finale.show .batt-row{ animation:none; filter:none; } }
  .batt{ display:flex; align-items:center; }
  .batt-shell{ width:132px; height:52px; border:3px solid #fff; border-radius:12px; padding:5px; }
  .batt-fill{ height:100%; width:100%; border-radius:5px;
    background:linear-gradient(180deg,#4ce38a,#1fbf5f); transition:none; }
  .batt-cap{ width:7px; height:20px; background:#fff; border-radius:0 4px 4px 0; margin-left:3px; }
  .batt-num{ color:#fff; font-weight:900; font-size:44px; line-height:1;
    font-variant-numeric:tabular-nums; text-shadow:0 2px 14px rgba(0,10,30,.5); }
  .batt-num small{ font-size:22px; font-weight:700; margin-left:2px; }
  .batt-note{ color:rgba(255,255,255,.65); font-size:10.5px; margin-top:-6px; }
  #finale h1{ color:#fff; font-size:29px; font-weight:900; line-height:1.45; letter-spacing:.01em;
    text-shadow:0 2px 18px rgba(0,10,30,.55); }
  #finale .sub{ color:rgba(255,255,255,.92); font-size:13.5px; text-shadow:0 1px 10px rgba(0,10,30,.5); }

  .pill{
    display:flex; align-items:center; justify-content:center; width:100%; min-height:56px;
    background:var(--ink); color:#fff; border:none; border-radius:999px;
    font-family:inherit; font-size:16px; font-weight:700; letter-spacing:.04em; cursor:pointer;
    box-shadow:0 8px 28px rgba(0,10,30,.35);
  }
  .pill:active{ transform:scale(.985); }
  .pill.light{ background:#fff; color:var(--ink); }

  #skip{ position:absolute; right:16px; top:calc(env(safe-area-inset-top, 0px) + 16px); z-index:5;
    background:rgba(10,18,40,.4); color:rgba(255,255,255,.9); border:1px solid rgba(255,255,255,.45);
    border-radius:999px; padding:7px 16px; font-family:inherit; font-size:12px; cursor:pointer;
    backdrop-filter:blur(4px); transition:opacity .4s; }
  #skip.hide{ opacity:0; pointer-events:none; }

  /* ───────── FORM ───────── */
  main{ max-width:480px; margin:0 auto; padding:44px 22px 72px; }
  h2.formtitle{ color:var(--ink); font-size:23px; font-weight:700; line-height:1.5; }
  .formlede{ color:var(--mute); font-size:13px; margin-top:8px; }
  .steps{ display:flex; gap:8px; margin-top:18px; }
  .steps span{ flex:1; text-align:center; border-radius:999px;
    background:linear-gradient(135deg,#eef5ff 0%,#dbe9ff 100%);
    font-size:11px; color:#3b5a7e; padding:6px 4px; }
  form{ margin-top:26px; }
  .field{ margin-top:20px; }
  label.top{ display:flex; align-items:center; gap:8px; font-size:13px; font-weight:700; color:var(--ink); margin-bottom:8px; }
  .req{ font-size:10px; font-weight:700; color:#fff; background:var(--ink); padding:1px 8px; border-radius:999px; letter-spacing:.08em; }
  input[type=text], input[type=email], input[type=tel], select{
    width:100%; border:1px solid #d9d9de; border-radius:14px; background:#fff; color:var(--ink);
    font-family:inherit; font-size:16px; padding:14px 16px; appearance:none; -webkit-appearance:none;
    transition:border-color .15s; }
  input:focus, select:focus{ outline:none; border-color:var(--ink); }
  input::placeholder{ color:#b9b9bf; }
  .hint{ font-size:12px; color:var(--mute); margin-top:6px; }
  .row2{ display:flex; gap:10px; }
  .row2 > *{ flex:1; }
  .unit{ position:relative; }
  .unit span{ position:absolute; right:16px; top:50%; transform:translateY(-50%); color:var(--mute); font-size:13px; }
  .unit input{ padding-right:48px; }
  select{ background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%231a1a1a'/%3E%3C/svg%3E");
          background-repeat:no-repeat; background-position:right 16px center; }
  details.vin{ background:var(--surface); border-radius:14px; margin-top:10px; font-size:12.5px; }
  details.vin summary{ cursor:pointer; padding:11px 16px; font-weight:700; color:var(--ink); list-style:none; }
  details.vin summary::before{ content:"＋"; margin-right:8px; }
  details.vin[open] summary::before{ content:"−"; }
  details.vin div{ padding:0 16px 12px; color:var(--mute); }
  details.vin li{ margin:4px 0 4px 1.2em; }
  .consent{ display:flex; gap:12px; align-items:flex-start; margin-top:26px; padding:16px;
            background:var(--surface); border-radius:16px; font-size:13px; }
  .consent input{ width:19px; height:19px; margin-top:3px; accent-color:var(--ink); flex:none; }
  .consent a{ color:var(--ink); }
  .note{ font-size:11.5px; color:var(--mute); margin-top:14px; }
  .error{ display:none; background:#fdecec; color:var(--err); font-size:13px; border-radius:14px;
          padding:12px 16px; margin-top:18px; white-space:pre-wrap; }
  form .pill{ margin-top:22px; box-shadow:none; }
  form .pill:disabled{ opacity:.45; cursor:default; }

  #done{ display:none; margin-top:34px; background:var(--surface); border-radius:20px; padding:30px 24px; text-align:center; }
  #done .mark{ width:58px; height:58px; margin:0 auto; border-radius:999px; background:var(--green);
    display:flex; align-items:center; justify-content:center; }
  #done .mark svg{ width:26px; height:26px; }
  #done h3{ color:var(--ink); font-size:19px; margin:14px 0 6px; }
  #done p{ font-size:13.5px; color:var(--mute); }
  footer{ margin-top:26px; font-size:10.5px; color:var(--mute); letter-spacing:.06em; text-align:center; }

  @media (prefers-reduced-motion: reduce){
    html{ scroll-behavior:auto; }
    .cap, #finale{ transition:none; }
  }
</style>
</head>
<body>

<!-- ───────── ファーストビュー ───────── -->
<section id="hero">
  <video id="hv" src="${HERO_VIDEO}" poster="${HERO_POSTER}" muted playsinline autoplay preload="auto"></video>
  <div class="poster" aria-hidden="true"></div>
  <div class="scrim" aria-hidden="true"></div>
  <div class="hbrand">${logoSvg('#ffffff', 'hero')}</div>
  <button id="skip" type="button">スキップ →</button>

  <p class="cap" id="cap1">今日も走る、あなたのテスラ。</p>
  <p class="cap" id="cap2">その走りの裏で――</p>
  <p class="cap" id="cap3">バッテリーは、静かに劣化しています。</p>

  <div id="finale">
    <div class="batt-row" aria-hidden="true">
      <div class="batt"><div class="batt-shell"><div class="batt-fill" id="bfill"></div></div><div class="batt-cap"></div></div>
      <div class="batt-num"><span id="bnum">100</span><small>%</small></div>
    </div>
    <p class="batt-note">※数値はイメージです</p>
    <h1>いま何％残っているか、<br>知っていますか？</h1>
    <p class="sub">車両の実データから劣化率と現在の充電容量を無料で診断。<br>結果はLINEでお届けします。</p>
    <button class="pill light" type="button" onclick="document.getElementById('form-section').scrollIntoView({behavior:'smooth'})">無料で診断する（入力1分）</button>
  </div>
</section>

<!-- ───────── フォーム ───────── -->
<main id="form-section">
  <h2 class="formtitle">テスラバッテリー診断</h2>
  <p class="formlede">入力いただいた車台番号（VIN）から車両データを照会し、<b>バッテリー劣化率</b>と<b>現在の充電容量</b>を診断します。</p>
  <div class="steps"><span>① 1分で入力</span><span>② データ照会</span><span>③ LINEで結果</span></div>

  <form id="f" novalidate>
    <div class="field">
      <label class="top" for="name">お名前 <span class="req">必須</span></label>
      <input type="text" id="name" autocomplete="name" placeholder="山田 太郎">
    </div>
    <div class="field">
      <label class="top" for="email">メールアドレス <span class="req">必須</span></label>
      <input type="email" id="email" autocomplete="email" inputmode="email" placeholder="taro@example.com">
    </div>
    <div class="field">
      <label class="top" for="phone">電話番号 <span class="req">必須</span></label>
      <input type="tel" id="phone" autocomplete="tel" inputmode="numeric" placeholder="09012345678">
    </div>
    <div class="field">
      <label class="top" for="vin">VIN（車台番号・17桁） <span class="req">必須</span></label>
      <input type="text" id="vin" maxlength="17" autocapitalize="characters" autocomplete="off"
             placeholder="5YJ3E7EBXKF******" style="text-transform:uppercase">
      <details class="vin">
        <summary>VINの探し方</summary>
        <div>
          <ul>
            <li>テスラアプリの車両画面 いちばん下に記載（<b>長押しでコピーできます</b>）</li>
            <li>フロントガラス左下（外から見えるプレート）</li>
            <li>運転席ドアを開けた枠のラベル</li>
            <li>車検証の「車台番号」欄</li>
          </ul>
        </div>
      </details>
    </div>
    <div class="field">
      <label class="top" for="odo">走行距離 <span class="req">必須</span></label>
      <div class="unit"><input type="text" id="odo" inputmode="numeric" placeholder="35000"><span>km</span></div>
    </div>
    <div class="field">
      <label class="top">次回車検の年月 <span class="req">必須</span></label>
      <div class="row2">
        <select id="sy"><option value="">年</option></select>
        <select id="sm"><option value="">月</option></select>
      </div>
      <p class="hint">車検のタイミングに合わせて、売却のベストな時期もご案内できます。</p>
    </div>

    <label class="consent">
      <input type="checkbox" id="consent">
      <span><a href="https://lightning.boxiv.co.jp/terms" target="_blank" rel="noopener">利用規約</a>・<a href="https://boxiv.co.jp/privacy" target="_blank" rel="noopener">プライバシーポリシー</a>に同意し、診断結果と関連するご案内をLINE・メールで受け取ります。</span>
    </label>

    <div class="error" id="err"></div>
    <button class="pill" id="submit" type="submit">無料で診断を申し込む</button>
    <p class="note">※診断結果は推定・参考値です。実際の売却価格を保証するものではありません。</p>
  </form>

  <div id="done">
    <div class="mark"><svg viewBox="0 0 24 24" fill="none"><path d="M4 12.5L10 18.5L20 6.5" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <h3>受け付けました</h3>
    <p>診断結果は <b>1営業日以内</b> にLINEでお送りします。<br>そのままお待ちください。</p>
  </div>

  <footer>©BOXIV Inc 2026</footer>
</main>

<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<script>
(function(){
  var LIFF_ID = ${JSON.stringify(liffId)};
  var profile = { userId:'', displayName:'' };

  /* ── ヒーロー動画シーケンス ── */
  var hero = document.getElementById('hero');
  var video = document.getElementById('hv');
  var skip = document.getElementById('skip');
  var finale = document.getElementById('finale');
  var caps = [
    { el: document.getElementById('cap1'), t: 0.8, out: 3.6 },
    { el: document.getElementById('cap2'), t: 4.4, out: 6.9 },
    { el: document.getElementById('cap3'), t: 7.4, out: 10.6 }
  ];
  var finaleShown = false;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function showFinale(){
    if (finaleShown) return;
    finaleShown = true;
    caps.forEach(function(c){ c.el.classList.remove('show'); });
    skip.classList.add('hide');
    finale.classList.add('show');
    animateBattery();
  }
  function animateBattery(){
    var fill = document.getElementById('bfill');
    var numEl = document.getElementById('bnum');
    var from = 100, to = 91.8, dur = 2200, t0 = null;
    function step(ts){
      if (!t0) t0 = ts;
      var p = Math.min((ts - t0) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      var val = from + (to - from) * eased;
      fill.style.width = val + '%';
      numEl.textContent = val.toFixed(1);
      if (p < 1) requestAnimationFrame(step);
    }
    if (reduced) { fill.style.width = to + '%'; numEl.textContent = to.toFixed(1); return; }
    requestAnimationFrame(step);
  }
  function heroFallback(){ hero.classList.add('no-video'); showFinale(); }

  if (reduced) { heroFallback(); }
  else {
    video.addEventListener('error', heroFallback);
    // 自動再生ブロック時もフォールバック
    var playPromise = video.play ? video.play() : null;
    if (playPromise && playPromise.catch) playPromise.catch(function(){ heroFallback(); });
    setTimeout(function(){ if (video.readyState < 2 && !finaleShown) heroFallback(); }, 4000);
    video.addEventListener('timeupdate', function(){
      var t = video.currentTime;
      caps.forEach(function(c){ c.el.classList.toggle('show', t >= c.t && t < c.out); });
      if (t >= 11.2) showFinale();
    });
    video.addEventListener('ended', showFinale);
    skip.addEventListener('click', function(){
      try { video.currentTime = Math.max(video.duration - 0.15, 0); } catch(e){}
      showFinale();
    });
  }

  /* ── 車検 年月セレクト（今年〜+6年） ── */
  var yEl = document.getElementById('sy'), mEl = document.getElementById('sm');
  var thisYear = new Date().getFullYear();
  for (var y = thisYear; y <= thisYear + 6; y++) yEl.insertAdjacentHTML('beforeend', '<option>' + y + '</option>');
  for (var m = 1; m <= 12; m++) mEl.insertAdjacentHTML('beforeend', '<option>' + m + '</option>');

  /* ── 流入パラメータ（UTM等） ── */
  var utm = {};
  new URLSearchParams(location.search).forEach(function(v, k){
    if (/^(utm_|campaign|adid|ref$|liff\\.state)/.test(k)) utm[k] = v;
  });

  /* ── LIFF 初期化（失敗してもフォームは使える） ── */
  if (LIFF_ID && window.liff) {
    liff.init({ liffId: LIFF_ID }).then(function(){
      if (liff.isLoggedIn()) return liff.getProfile();
    }).then(function(p){
      if (p) { profile.userId = p.userId || ''; profile.displayName = p.displayName || ''; }
    }).catch(function(e){ try { console.warn('liff init/profile skipped:', e); } catch(_){} });
  }

  /* ── 送信 ── */
  var form = document.getElementById('f');
  var err = document.getElementById('err');
  var btn = document.getElementById('submit');

  form.addEventListener('submit', function(ev){
    ev.preventDefault();
    err.style.display = 'none';
    var v = function(id){ return document.getElementById(id).value.trim(); };
    var problems = [];
    if (!v('name')) problems.push('お名前を入力してください');
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v('email'))) problems.push('メールアドレスの形式が正しくありません');
    if (!/^[\\d-]{10,13}$/.test(v('phone').replace(/[０-９]/g, function(c){ return String.fromCharCode(c.charCodeAt(0)-0xFEE0); })))
      problems.push('電話番号は数字10〜11桁で入力してください');
    var vin = v('vin').toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) problems.push('VINは17桁の英数字です（I・O・Qは含まれません）');
    if (!/^\\d+$/.test(v('odo').replace(/,/g,''))) problems.push('走行距離を数字で入力してください');
    if (!yEl.value || !mEl.value) problems.push('次回車検の年月を選択してください');
    if (!document.getElementById('consent').checked) problems.push('同意にチェックしてください');
    if (problems.length) { err.textContent = problems.join('\\n'); err.style.display = 'block'; return; }

    btn.disabled = true; btn.textContent = '送信中…';
    fetch('/diagnosis-form/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: v('name'), email: v('email'), phone: v('phone'),
        vin: vin, odometer_km: v('odo').replace(/,/g,''),
        shaken_month: yEl.value + '-' + ('0' + mEl.value).slice(-2),
        consent: true,
        line_user_id: profile.userId, display_name: profile.displayName,
        utm: Object.keys(utm).length ? JSON.stringify(utm) : ''
      })
    }).then(function(r){ return r.json(); }).then(function(res){
      if (res && res.success) {
        form.style.display = 'none';
        document.getElementById('done').style.display = 'block';
        document.getElementById('done').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
      } else {
        err.textContent = (res && res.error) || '送信に失敗しました。時間をおいて再度お試しください。';
        err.style.display = 'block';
        btn.disabled = false; btn.textContent = '無料で診断を申し込む';
      }
    }).catch(function(){
      err.textContent = '通信エラーが発生しました。電波状況をご確認のうえ再度お試しください。';
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = '無料で診断を申し込む';
    });
  });
})();
</script>
</body>
</html>`;
}
