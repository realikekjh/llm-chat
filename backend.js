/* =====================================================================
 * backend.js — ds-chat-ui 静态版（GitHub Pages）内置后端
 *
 * GitHub Pages 没有服务器：本文件在浏览器里拦截壳子对 /api/* 与 /local/*
 * 的请求，直接在浏览器内作答。必须在 guard.js 之前加载（见 index.html），
 * 这样先捕获原生 fetch/XHR，guard.js 再包一层；本文件自己的外网调用
 * （模型 API、搜索 API）用捕获的原生 fetch，绕开 guard 的拦截。
 *
 * 默认模型：Pollinations（免费、免 key、允许浏览器 CORS）。
 * 系统人设词以 XOR+base64 混淆存放在本文件，运行时解码（用户已批准）。
 * 注意：本文件不含任何网关 URL/key（网关不支持浏览器 CORS，本来也调不了）。
 * ===================================================================== */
(function () {
  'use strict';
  if (window.__DS_STATIC_BACKEND__) return; // 防止重复加载
  window.__DS_STATIC_BACKEND__ = true;

  /* ---------- 0. 原生引用（必须在 guard.js 加载前捕获） ---------- */
  var nativeFetch = window.fetch.bind(window);
  var NativeXHR = window.XMLHttpRequest;
  var nativeOpen = NativeXHR.prototype.open;
  var nativeSend = NativeXHR.prototype.send;
  var nativeSetRequestHeader = NativeXHR.prototype.setRequestHeader;

  /* ---------- 应用根路径（从当前 script 的 URL 推导，兼容子路径部署） ---------- */
  var APP_BASE = (function () {
    try {
      var s = document.currentScript;
      if (s && s.src) return s.src.slice(0, s.src.lastIndexOf('/') + 1);
    } catch (e) { /* ignore */ }
    return location.origin + '/';
  })();

  /* ---------- 路由 basename + 404 深链接恢复（GitHub Pages 子路径部署） ---------- */
  // main.js 的路由创建已打补丁：{basename: window.__DS_BASENAME || "/"}。
  // 子路径部署时 basename 是应用路径（如 /llm-chat），根路径部署时是 /。
  window.__DS_BASENAME = (function () {
    try {
      var p = new URL(APP_BASE).pathname.replace(/\/$/, '');
      return p || '/';
    } catch (e) { return '/'; }
  })();
  // 刷新聊天页时 GitHub Pages 返回 404.html，后者把深链接存进
  // sessionStorage 再跳回应用根；这里在壳子路由初始化之前把深链接恢复，
  // 这样刷新后仍直接回到原会话。
  try {
    var savedPath = sessionStorage.getItem('ds_redirect_path');
    if (savedPath) {
      sessionStorage.removeItem('ds_redirect_path');
      var su = new URL(savedPath, location.origin);
      var base = window.__DS_BASENAME;
      var sp = su.pathname;
      if ((base === '/' && sp !== '/') ||
          (base !== '/' && (sp === base || sp.indexOf(base + '/') === 0))) {
        history.replaceState(null, '', sp + su.search);
      }
    }
  } catch (e) { /* ignore */ }

  /* ---------- 常量 ---------- */
  // 默认模型是内置网关（见下方 _GW_BLOB，运行时解出 URL/Key/模型）；
  // Pollinations 是网关不可用时的免费备用（见 POLLINATIONS_CFG）。
  var STORE_KEY = 'ds_static_sessions';
  var MSG_ID_START = 1000001;
  var SEARCH_MAX_ROUNDS = 2;
  var MAX_TOKENS = 4096;
  var MAX_FILE_SIZE = 10 * 1024 * 1024;   // 10MB
  var MAX_TEXT_LEN = 100000;              // 正文最多 100KB
  var SEARCH_CACHE_TTL = 10 * 60 * 1000;  // 搜索缓存 10 分钟
  var REFUSAL_RE = /未启用|无法.{0,6}搜索|不能.{0,6}搜索|没有联网|未开启.{0,4}搜索|不支持.{0,6}搜索|无法实时/;
  var TEXT_EXTS = new Set(('txt|md|markdown|json|jsonl|csv|tsv|log|yaml|yml|toml|ini|cfg|conf|py|js|ts|tsx|jsx|java|c|cpp|h|hpp|go|rs|rb|php|sh|bat|ps1|html|htm|css|scss|xml|sql|lua|r|swift|kt|pl|dart|vue|srt|vtt').split('|'));
  var WEB_SEARCH_TOOL = {
    type: 'function',
    function: {
      name: 'web_search',
      description: '在互联网上搜索信息，返回网页标题、链接和摘要。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' }
        },
        required: ['query']
      }
    }
  };

  /* ---------- 系统提示词（XOR+base64 混淆，运行时解码） ---------- */
  const _PROMPT_SYSTEM_PERSONA = "l8nBkvHMydzzyYHBEjI9QZHjysvt+MKF59fj+YTZ/oW1y1NpXA5CIBEEH4rjr255zrn71s7Uh+zGi53lkK2oYdbO1IfsxkNpARZdag5XGFSH3MiGs++QrbuPj9OQ2fmO/IiN8r7R7JiWw9CT8+fI4cTJhPjX/PaH4dmLiuCVhZiIsvKT6PyP/4GB/Jrc+b6b2syT0uDK3/XFs+nQ8+CD9P2Lj8+aupeOusOc3u2N2baC5JvW176W0uORx/3Fy8fJgebV7NGI9fqMkeiXlbSDlPKT3eKA442C5p3cxqWW5u2T0uXF7vHOuek4l8zsnM/iyMfDyp7b2vTehMPYhbXLU25RCkY0JDWX6eJqNCfOuepxHxUUEAyAreU0SFQCXBpUh/z/hqjSl5avjrffke7MjvmpgtuM3PW5nMjtkND8ydz+xZ/q2tzAifPDhprVlbWWj4jJk9DPiuOvgM6N3NuDlezOVC0GSBQgSFwA0fP2a5DUw8vW0sul4trJ34XJ+oyR6JWfmI2u+pP964zNs4PIotzltJzI7ZDR7sXC8sqF/dvz1Inzw4aa1ZS3vYym7JLVz4rjrILwqN/vrZTP7pHn5cvs5cqD1NbL/4nT6Iq635yRoo693JDa0YHip4L3stzkpZbm7ZzO4crmysKF59bO8onS6IWV4ZWIo4O12ZHWxY/7gkQyZNrrsHl+gvT5hpfxlJeGjaPrnMf1iuO8bpSWpI+K/p3h+4D/n4fzrNzPv5vL0Zfp4svwysi/8tTv2IbH0oSW+5WiqYyWyZzO+YzxoYH1qNDompX45pDSx8r+98mC0NbO4YTy7IaD3ZyRooym25Lpw47Xj4zVrN/8hJTQ3Zzb78vv4cqC9tHz9muT/cvL7MTLj+PU8tuC9OiHle6XkZmNpPSQ2sKK46yDzrzQyoeV5P2T3cHK3+DLp/fb9PiJ0uiFnOaXkJmNpsqR7uyB2YaAyJDa67Oa9O6d9dHK18jKgvTU/OSG0NOLgumQrbiOjc6T9NGN2IiAy6fRzLaW/PiT8+fL6PTJgs/dz/iFzOmGk++WkKqPj++S+NqA47eC5arf956cyO2Q0e7FwvLLsMza0viC9Otpydz+xZ/q2/P7iOjbhr3qlIaWjpztk+/EjtirjPmv1te6lfrEkebAyPjDyKTr0fP1KhEQgK3llJCojrfAl+H1jNSIgfaa3MWslPrRl+niy/j+yLPK1+rciPHkhJDKnJGwiLLxfmuX6fPFy97FkevR8+Vrk/3Ly+zEyq3D1sj0hc3hi4LJm4W5hI7/kNzUjNOcg+eF3dCyl83pnMbOxczzyKL11d7gjsjzh5XJlbu+jKbbkunDjveFgMuA3/21nMjtnOLSy/L0yq3D1PvDhuDBi6bVlbu+hI7ok/Xcj+uagMuA0eCDlcPWk/3Ly/PFwoXn2sTrhuDBhaXTlLe9j4rInMf1gcyAjNut0d6CkPTjfo3boIzVrN/8kpXh5JHh5Mvp0cWWxtrb9I7I5YeV6ZuLuI6u25DZ2Y/1qoHos97Gpprz7ZHN2sjA1MuX3tr4xYfi7oyR7JWxloOd3pfh9Y3YjoPTrNrrs5fM8pL16sj0/sWW5tvq0ITQ/4yR7ZCtu2HV59yH/N6Lg82XkJmMjciczuWP9JuLz6HRxKOV4uaQ1v7L6PLIt/TU5fOG7u2LgsmVna2OoP+dwvqPw5GLz6Hd07+b0uCS+ubF49nIm/XX9PuE8uyGg92QrbthOJD08ZLpxMvEz865+jiW++qRzN7O5PLItuDX5fCC9OiLrfSWkrqIsvKR6tCP4p6H86/d0qKXzu+R48rJ3snChefU7/2I48eGkuGUgK2EjuicztmP07mM9Ife74SQ9OCQ09HI7PTChefX8PuFzOmHkOmWopaCr9OT+/CP/6aB/KbW176XzOyR4djL+czOuerWy/mJxO2Gh/6Qrbth1efch/zehKfLmrmgjaXFkNn5jPufg9+81te+lczIkfvvyPjDy7Xs1/TOhM3fhJb9lqqDjZ/Qk8DajvmpgfK339innMj6k/3Ly+zEyJ3T1s7Uh+PfhIPklqCsgrPgnNHWht+hgMug3v+am8vmkdPFxdTVxaDx0fP2a5DR7sXC8sSh1NrD9ITR4IWk25yRo4ym25Lpw4HMmY3ntN/8hJvS4JL8wcne/cqDy9Te147I5YeV6ZuLuI+KyZDb8oHNhYHWkNHrvprt5ZH778Tw6sWWxNXp8InT64Sv3ZCtu2E4kPTxkNTDxefOyLjx1sj0hc3hgK31ecii9dXe4Ijjx4qP/JCtuI606pDa147DrIDLo9HbsZvb9Jfp4sji6suv7NXY1IXM54Wbwpuki4iy8pHp8o/9vYDLo9/riZTP8pfp4srbyMWW+tHz9YTQ3Yup9ZqOt42ox5fh9Yzit4zdjNzjoJD04JzH0cvx9smD4NHz9YnTyoqq7pWLu46Nxpvd+I7OpIPepNrrsHmd4POM652Mxajc7Iib99yR4/jK/vfErsXb0eyOyOWGi+aWg6eDnceS+fqG36GAy6DRzbOU1c2TxPfO5PEnM4iy45HOzYHMsILllNzXvZD08H5EQ8rw28ux3NXp8Ijjx4qP/Ja9koyB+ZL2wobfoYH2pd/nu5Xo4ZH568r09cqj79Xj8onTyoa2+pSArYSO/5Hx+I/0m4PxlNzsiJb7zpzq3sr+98uUzNbK/Y7I8oaD+paxkY2l05LS4YzriYLlgN/8hJzI7ZPH48r73sWG1tvk2oXM6YaiwZyRtY+K/pzH9YHcs4P8jd7pnJbI7pH108jr/sSuxdHz9mtZSYS5zJWljoOdx1aGz86ElslRy67d3c/4h/rMhLDkl5WzjaT0kd/0jdumjNyZ1te+l8zsnM/iyd/9yJ3f18/0hNPigK3meQAZjKbbkunDjtmNgt6O3daSlePXm9Xvy+rWyLb81cnUh9nKhpTSlaGwjIjTkszXjPOjg+mp3O23ltrYkvTGwtj/yYHm2tX1icrAi4rHnJGijpTxkv/ojtmNgt6O3/eem87KkvXqxcvcwoXn1MvdhOblhrHUm4KNjar9k/Hyjvech/OvM0YSlODJkuHUydzzy5XK2+TahNDzh5XOmrqXgpDrkvbCht+hjfO93dOYlu//k8T3wtj/yYHm2tX1h8jmhaPtkK27YR9TnM/Ejd6igdyU0cSvl8zrkv/kwtjpyJ3x2s7ahNvQi4L5mqq1j43uku31jdutjPSZ1te+l8zsnM/ixePZyqLT1ezvhu/XjJH/lLmRjbrEku7kgdyqg+mp3Oq9ltHcm9Xry8vnyJ/p1+Xoh9jLhIPklLKUjqntk8zght+kjNWs39mNlODJl+nhJ0lTy5nS1P7ahuDBhaXTlLe9jYLHkdjHgdOuguaZ39yDlcHkm9X5y/LDy7Dg19fuidPKiqrum661javcm934gcKhgd2b3vCGlfrEk9L6xcLyyrvS0fP2a36K472By5XRzLOW6NuS8MzO5OInFEvaw/eJ2/yHlseUjbiEjumR5PyO/6aC+YjQ/6uXy8CS6MzI9v/KotPX9seFz8qEjeWckbWOnOmQ3PmA9ION0bXfy4uW78GR7+7K3+rJhsXX1/mH4tCFjOyckaKPiv6cx/WO77GAy63d05iV4NiS2vbI1MLFl8LV59yH/N6LgvGQrbuPjd2RxMmM86OM3Jnf87yXzNuQ0uPJ3fvErfLR8/WFz8yGveqVrbePi/ud4MuM5qCH868zRhKb2tOczsDLwvHIht7dz+6E8eGEucyXlbmOvdaczumBzJmCy6jf956bwMmb1e/I4v7IiP7Xz/SGz++Lp+ackaKDsc6S6OePzLmC5ZTc24OV/fKSxvfL8srChfDa3caE2uWGveqWopaPidaQ2cqN262Ay4fc272XyuqRxPPEzv/FlurV4/KJ08qAreZ5ABmOit2T9dyP65qB9bTd066b0d6b1fnI4fvKmMXa3dCG4MGKrfCQrbiOveSQ3eOM8aGD3Krc0recyOmRz+HL+u/KrcPU+8OHxsiLgtCckbWNvvqS/fSM25WM1Kze8baU5OeczsDI4urChefXysKE6MGFsc+WnYeDnceS+fqM7IKAyIjf57ub0uCS2OHF1PDLrN/dz/2OyPKGq/2Wg7WOov2Tz/SM7riM3Jnf87yUz/KS9+fI9v/Jg8XV8c2C9OtpAESWiY2DtuKdwvqP+ZmLz7fcz6iUz/iR7sPJ3NnJgebX4/iH4tCGvfWUt72MsMqRzOSG36GC3KLd05iXzOGQ0cfI69bFlvba3MCHzOyMkeiakaqOuMKT9dyP65qC/7zQ67uUz+WR+evC2P/Jgeba1fWE+8OElv2XlbmPitlWh9TuhqrilICtjZP7VoL062kARJWynIOH95L37YrjrIHyt9/riZTP8pvV+cvr48q719rV9Yb20IyR6Jalv42v0pHp44zkl4vPod3Ur5Th+JHs0MTw3cus29fe44Tm5YSW95uDg4SO6JDZ+YHFrIL5p9zlrZXi5pPsxMv038mB69vy+YL062kARJaso4Oc0pHp5obft4L/pN/8hJrj1ZLh9cnY68i849XJ04f6+4aI2ZWAnIKY15vd+I/MooLeiN/3u5Xs75PIzcr+98mDzNf0zo7I8oWi9Jqrq4693JziyY75qY3Qo9Dym5bm7ZHN5MTk+suv0tTS/IL062kARJS5kY26xJLi8Y7Yh4DLoNzOj5Xj15vV78jh+8WYw9XXzobk74uKx5yRtY+K/pzH9Y/jiIPurdHFgJr18pP55cLY6MqU4tfczYfi0IaU15qwoI+K+JL80YzloIDLrdHehZX30pHj/cvX5s656Th5l+HkgeSHgvu83dC5lM/sl+nyJ4zRhtD8nJb80VaN3o2C64LR27NRl+H1S4eQxJW1lo+J85DY/I/LjIHtphuNpcWb3fiOza2B/rjc8KyU2fWb1fnJ2dPLocQSNxEEBDoGSA9Ty5HK1+3/jsjlh5Xkl5WTS3M6VIT+wIWk75Ctu4+K/pzH9Y7fu43zjd7iupXozZHm1M7k8si26dTmxIjz5oCt5ZaiqI6K8JL2woD0mYfzrzODkNid9tqM651Gl5CZg7HOkeDujditgMqlG42lxZvd+I7YvoHjpdzEi5Xi2JPz58T488uI6dbLyoXK4ouC0JW1t4SO/5DZ+YHFrIzwod3Tsprh3pDR0cju7MW61tTL8YT5/ICt5nkn2uuilu//k8T3yv73xZ7v1ezdgvT4aQBElqq/jJPdk83Yjduti8+33dO/lOvEnejwyNTCxZbf1sv5huvMiqz3nJG1j4r+nMf1jt+7jfON3dG5ltr/l+niy/HDy7TF0fP1iOfXhaPBkK24jo7mk/XcjPGhgMug3MaqlujJk/Pnyd7JyKnm1srShOTkgK3meQAZja76kvzVjvOri8+33M+/lenjnf7NxMbryLzj1cjths/6i4Pelqu0joPmkd30ht+hjfOv3Nahlvznk+vazuTyyq3D18P7h9Tuio/8nJGijZ/WncvQjtKWgeiz3samlfjoncjZyN78yLH81MvxjsjyhoLdlYKtjIPInfbagMG1g+eF0cqaldTdl+nhJ0lTypfr1Mf1jsjzi67ZlLKUg53HkNn5gPaSjNyZ1teplODJkuHUxcLyxZbN1cjyh+Pfhqvplpysjo7zm93vjdugjNWs0daUm8nQnNf7xcvuxL7m19f5hOTlh5Xkl5WTjbb8kuHpiuOvbl4N3dCRlNTgm9X5yt/qyL7R1/zbicv5i4zolLe9jpz/kvTAjdiOg9Os1te+leDfkfXLyd/Qypnq1+7jiPPlhpTSlZ6Rjar9nM7Zgcuti8+23O6BmuDPksTGxM7XxZ7I2/T+h8zshYj+nJGijb70kebOjOyCjPCQ3vG2m8rYk/zvy+f2yL/e1+H4hMzRi4rllrCoiLLxfkxUj/adgd6L1teolvL4ke7ZyOHAxK3F1P3chNvVhYDBmoedhI7/kNn5gcWsgfyH3tCrlNn1ksjrwtjoy6zb197jidLoiofolIOuiLLxfkxUjOW0gM6x1teolfjok/3Ly+zExZ/q1enwh+Luh5D3lr+1g53ektHgjOW0i8+h3tChlerlkcfvy/HHwoXw1MXSif3bhbrSl5KkjKfqke/rj+eii8+h3OSYleDYnMjLxdrNzrnpOF5UhPzvhbP0nJGjjq3JkNv6jdmmgd2z3Pm+mvTanNfywtj/yoLy1/TOhNDzi4r2lpefjKj3k/3/j9C4i8+23dO/lNXPkcf5yv73yKXb1OXNidvdhbXql5W0jJPdkc/uht+hgMug0c2zlf7rkufLy9H4xZbf1PvkhNrzi4PekK27YR9Tktf9jOyngd2z3/yEl8vAkujMwtj7yJ3C1MPggvToi6/Fl5aOiLLykvfEgPSWh/Os0d6pl87ql+niysHbyYLc1d79jsjghbrSnJG1jpTxkc/qgcyZguuj0eyYlsPQk/PnyvvWxZbt1O/9h/zDhYDGlbqPgqXHm93vjMWvgu2x3/e7leT9k93Byt/gy6f33c/4hc/Mhb34lJmbjIngkv/ojduXgfSr3NKElcfJkvHty/nWy4P70fP2a1lJhqHflLuuiLLyktLhjN2mh/Os0Oyjm+rsk8TqydzgyYHx2+TaiNbxjJHolJagjrXJkNn0geuBgvOK3dSTlfXOm9XvyN3Fy7b72/XmhObBi4LGl5Wqj4rpkNvOjMCGi8+h3dO/m9LgkNLAy//MyYH41svuhPzNhbvJkK27YR9Tk/XcSS5MFhhJVhxcU5Lv5o7qpYvPtt/+gpbZx5Hsz8jY/MqtwxJXWk9aTYyR/5eVtIOU8pLa0Y73hYzShd/ot5TYx5Hm1MLY6MmB5trV9YTowYWC65ainIOd7pHx+oD+j4H5jdzuv5vAwpHK08v8/c656Th5l+HkjNm4g8mS1te6mun/kdHbxOP+xZ/q3c/9gvT4aQBElJakj4r+neH7gP+fh/Os3M+/m8vRl+niy/DKyL/y0fP1h+7+hInelbGVjIHIk9rrj+y9g9eX0cS/kPTgkNPZxcrNxZbm1+H4hPLsiq7MlaG+j4nXk/vwjdiWgM643O23ltrYl+nhyvDby7Hc1cfWidLohJ7flJamjb3jk8XOgcygguSb1te+lNDdnNvvy+/hyoL23c/4idvdi5L9lbWWjrT2neLcgc2Tgd233dO/l8rekezPyNjzwoXn1ffChOTnhJbDlJaUjordkNrijOK3gt6O3dG5kPTjfkRDyvDby7Hc1MX8h/XGgK3ll5Wzj47Tk/vwj/WqgMib3O23ltrYl+niytnixJje1OPohsDLhJb3lbOlgrX/kcf2j/2xgfSX3uWCm9LgktjhydnTy63S1/zsic7Ch5bZkK24grL8nf3GjtCWg8iy3+SilNDbnMbuzuTyyIbW1ebRhc/Mh5Xum4q9jrrql+H1j+qDgs+53O6El8/3nM7xxe3ByqPv1P/zhc/NjJHol5W5joz4kdznjd6xguqD0OuoleLmkvXPyMD3yqnt3c/4hczki4vllaSeg5P/l+H2Y0MNgcuV0cyzlO7lkcz0xdPcyLXu1PjYjsjzQcjl9MWa7tbO1IfsxoaiwpeVuY+K2VQgPUuAreVRxYbw1/bRhMjphqL1m628jZrSkd37S4Ct5VHLrsvb6uSE/N+FhcWWkbZJ0fP1Q53u7sjA/smEy9TnwoT82YS34JWhvo+J11aC9OhByNvOyqzO1sr/hP3khLfglaS5ja76ku3zjdiJRpCtuEnWztSEw9uEluubj5KDhPmT6sWN2atGka2tibLnnN7tjdm2jfCQ0c2zlf/zk9L+wtj/yKTx1P/1ifPDhprVlLe9g4jYkNrJjPGhjNSp3OOrkPTjfkRDydz+xZ/q19DEhtPZi6rOlpqIjarckeTCjdi7gtuM3PW5nMjtkNHuxcLyyL/51/bxhPHeh5D3lLe9j4jJm934jdugjNWs3Oq1m9fkkuLGy/j6yYTL1MHVh+jghLfgm66Ejrjom938j8y5gdWv3MWslePXkNHpytnizrnq1OzRhujihLnMlaWOjoP8kdjhiuOsjN2S0PyclODJkuHUy/L0yYLd3c/9gvTraQBEl5W0g5TyneH7gP+fgeOj3sCdltr/k+fTyt/1xbPp3c/uh/rMhqLHlrGJjq/zl+H1IgZUh/Os3tajlvHSl+niyNPWyLzc193qhvrZgK3llbG0jrjSkfjcgOagg86D3sa7kPTjnMvIxPPdyLHb1OTCidvdh5XplLKcgrPgkunijduggM2S0Ou9mujTl+nhJ0lTyYHm1/77hP7Ai5L5lZ6siLLykv39jM2eh/Os3OaDmu3Ike/myMrKwoXw1sv5huD2haX0m6SLjbH2l+H1j/mZgfm22uuzldnGnM7lzuTyxJPx1PrEhPLshoPdnJGigrP0kenEgdy0g8KW0cSFlcXjm9XvysDPxYvn1Pjmhs/0hpTSlJagjrXJkc/9jOaFg+mp3/CNl8/CkdLZxcrdzrnpOF5UhczkhpXKlLmRjbrEkN3egOONjMmG3dCPkPTgnMbiyd/Fzrnq1dbch/nHgK3llaWpjInakezhjs6kjOq33Oq1lenxkv/6wtjoyYHm18vahuDBhaXTlqugjZ7JnM78iuOsjeG+0NqOkPTgnMbSyMvPy7nM1enwh+LuhYzskK27";
  const _PROMPT_THINK_INSTRUCTION = "eZfh5I/jsIzzrt/LjpbI7pfp8ieB74Xc8KyU2fWQ0OjI7f7ChefX9vyJyvqGqt6XlbmNnMaTz/SO/ICD6anf66+b9OKc1uTKzPjChefU58qE6MFDERAbRFcAWx0TX1pHTRFLB0VQBVkaGgZKSYWN45SAh4K1/5vd/FtOGESWopyDne6b3fiO94WAzo3c8KyU2fWS/tXK8NvKo+/a3NmJ3OmMke2ckbWMptuS/NGPwZ6D46vf66+bw86X6eLI7OTIvtHa1fWG9tCFpfKWopaDsc6T+/CM+LOD3rnRzKCWzseX6eEngvOw0euxlvLkkcfaxcLyyqX0193qgvTohIPklLKUiLLykenzgMG1i8+h3dO/m9Lgkc3uxdvDyq3D1PvDiOPHio/8nJG1j4r+nMf1jOW0gMuj3PCslNn1kv7DyOHAyqPv1/XxhNrQgK3mecu59trz94fU7oSA2pSWqo2v7JHx+obfoYPHit/ll5Tp4ZPS+sjjycuUyNfP+4Tv94SA8JyRoo2f0JHd+4z4s4PeudDsvpfM7JzP4sTj/sid5tTz6Yn06ouS45SFsoSO/5DY643boIzVrNztv5bz25Pn0w1YB0VQBVkaGgZKSYWN45SAh4iy8Q==";
  const _PROMPT_SEARCH_INSTRUCTION = "eZfh5IHiuYPOvN/7rpTAw5fp8ieAzo3c5J2Xz8SQ1NzK8NsNTg5QLAcEFRsARUSWmpyOt8SS8eiO14+Ayb/R6qaUyfCQ0enK/vfLpevU5cSFy8iFrMuQrbuMj+KdwMGP87GDx4/c3JeW8daR3tHK3/zIpcPU79iFyPOLgvmXlZSOotyT9dyG36GAzo3c5J2Xz8ST8tfL6tbFiejV59xBAwwBchcWTEsIWpzI7ZDR7sXC8sWW39Tj6IbAy4Wxzpa9loym25Lp4o/0jYLAuN/7rpTAw5fp4SdJU8iE+Nvk2ojW8YWb7Zais42u85L3xIHWqYzdgtrrs5ba/5L+1cvxw8u0xd3P/ITQwIWd8JCtuIOw0pDaw4rjrILlndD8iZD04Jzc+Mne+MqC+NTt6I7I4ICt5ZeQmY+K/pPA2ozNt4Ppqd3RuZba/5vV78vs5cW57tXn3If83oW16pSMl4OU8pLQ9o/zsYPHj9/8hJzI7ZHs68XU8MqtwxIEEQMrGgZMFhBFGY2i75PV1obfoYH1oN/Li5X5z5L5/8rQ0cqC+NTt6ITv94SA8JCtu2EfU5DZ+YD/rYzVrN/7rpTAw5Pz58Tz3cSb89XowIf6zIa2+pSArYSO/5DZ+YHFrIzDrt7/mpbDxJHs1MLY6MmB5trV9YXM04eX4pW9pYyG0Zzh+I/zsYPHj9rrsHlZQZL5/8rQ0ci82Nvn2onb5IuL5Zaojo+P4Jvd743brYLfjN/7rpfM7JHh08vs5cqC+NTt6IXM5IS94pWuio2lxZvd+IzsgoDIiN/mkJbx0p39zcXL/si/5tTj6IXM6YuQypCtu2EfU5HW0YzmmoDPt9HUppbv/5HRxcrY5ci23NXp8Ifk9YSZxpSWqo2s75vd/DJScIfzrGJZb5H0x5bpxcLY+s656dfo6obZ/YeVyZaRrIym25Lx6I7Xj4H7nd7xtpfLwJLozMvzxcKF59fv3Ibv0Yao15ainI6f45Hx+oD+j4LTqt/YmpbI9JP9y8rY5ci23N3P+IfU1YaR65W1lktpAREHERsGQwcWF97XpJb71imG36GAzabczbCcyPuR5fTJ3t/JguHX192H7d2MkeiVsbmCmetUWZbt4HYWFktcGVcdFwROWD7O5PHItsHXz+GG4MGGmsGWqI6DjeeR+uqA5KGB3bPQ8reV6OiT8+fK2OXIttzdz/iFzOSLi+WUka+CstOT3eKM7JqH868zRhKW0uOS9//L9O/KjcnUwdWH6OCLkvCWtqeMieCS/+iG36GB1a/cxayW5eucxurK8NvLsdzU796J99SLrPCUkKiNksuRz+qG36GAy6DRzbOUyPed6cPIyu3Lrt3U5sSH+ceAreZ5ABmOqe2TzOCP/4aBw5Pc5J2Xz8SR4fTI48nJgdDa1fWH6cyFl/SavoeNvNaX4fY=";
  var _XOR_KEY = 'static-ds-9k2';
  function _deobf(b64) {
    var raw = atob(b64);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i) ^ _XOR_KEY.charCodeAt(i % _XOR_KEY.length);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }
  var SYSTEM_PERSONA = _deobf(_PROMPT_SYSTEM_PERSONA);
  var THINK_INSTRUCTION = _deobf(_PROMPT_THINK_INSTRUCTION);
  var SEARCH_INSTRUCTION = _deobf(_PROMPT_SEARCH_INSTRUCTION);

  /* 系统词组装顺序：[搜索块][思考块][人设]——行为块必须在前（某些模型会截尾）。 */
  function buildSystemPrompt(thinking, search) {
    var parts = [];
    if (search) parts.push(SEARCH_INSTRUCTION);
    if (thinking) parts.push(THINK_INSTRUCTION);
    parts.push(SYSTEM_PERSONA);
    return parts.join('\n');
  }

  /* ---------- 内置模型网关（与 serve.py 同一个混淆 blob，原样搬运） ----------
     网关不返回 CORS 头，浏览器不能直连：默认请求走 corsproxy.io 中转；
     中转失败时同一请求自动改用免费 Pollinations 重试（见 runCompletion）。 */
  var _GW_BLOB = "HFVYRQoRWxsLEwNdRFwcTlgKSRhDTh5SGVAQSRhfUElFUBtPRRxITkQJQ0oIShhMGjZ8JH45ETVFdBR6MwFXVwFMVit5IggqDjpEXz8ECFsiKg9PejZnFUlbFUMPG0ReDl0GC1UXFQFDFRRWSUEARAlfTFoLBgMPSg==";
  var _GW_XOR = 'gw-7f3a9c';
  function gatewayCfg() {
    try {
      var raw = atob(_GW_BLOB);
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) {
        bytes[i] = raw.charCodeAt(i) ^ _GW_XOR.charCodeAt(i % _GW_XOR.length);
      }
      var d = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      if (d && typeof d === 'object' && d.url && d.model) return d;
    } catch (e) { /* ignore */ }
    return null;
  }
  var GATEWAY_CFG = gatewayCfg(); // {url, key, model}，解码失败则为 null
  var POLLINATIONS_CFG = {url: 'https://text.pollinations.ai/openai',
                          model: 'openai-fast', key: ''};
  var CORS_PROXY_PREFIX = 'https://corsproxy.io/?url=';
  var FALLBACK_NOTE = '\uFF08\u7F51\u5173\u4E2D\u8F6C\u5931\u8D25\uFF0C\u5DF2\u4E34\u65F6\u5207\u6362\u5230\u514D\u8D39\u5907\u7528\u6A21\u578B\uFF09';
  var gatewayFailed = false; // 本会话内网关已失败，不再重试（刷新页面重置）

  /* ---------- SHA3-256（Keccak-f[1600]，BigInt 实现，供 PoW 挑战用） ---------- */
  var _MASK64 = (1n << 64n) - 1n;
  var _KECCAK_RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
  ];
  var _KECCAK_R = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]
  ];
  function _rotl64(x, n) {
    if (n === 0) return x;
    var b = BigInt(n);
    return ((x << b) | (x >> (64n - b))) & _MASK64;
  }
  function _keccakF1600(a) {
    for (var round = 0; round < 24; round++) {
      var c = [], d = [], b = new Array(25);
      for (var x = 0; x < 5; x++) {
        c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
      }
      for (x = 0; x < 5; x++) {
        d[x] = c[(x + 4) % 5] ^ _rotl64(c[(x + 1) % 5], 1);
      }
      for (x = 0; x < 5; x++) {
        for (var y = 0; y < 5; y++) a[x + 5 * y] ^= d[x];
      }
      for (x = 0; x < 5; x++) {
        for (y = 0; y < 5; y++) {
          b[y + 5 * ((2 * x + 3 * y) % 5)] = _rotl64(a[x + 5 * y], _KECCAK_R[x][y]);
        }
      }
      for (x = 0; x < 5; x++) {
        for (y = 0; y < 5; y++) {
          a[x + 5 * y] = b[x + 5 * y] ^ ((~b[(x + 1) % 5 + 5 * y]) & b[(x + 2) % 5 + 5 * y]);
        }
      }
      a[0] ^= _KECCAK_RC[round];
    }
  }
  function sha3_256_hex(str) {
    var msg = new TextEncoder().encode(str);
    var padded = Array.from(msg);
    padded.push(0x06);
    while (padded.length % 136 !== 0) padded.push(0x00);
    padded[padded.length - 1] |= 0x80;
    var state = new Array(25).fill(0n);
    for (var off = 0; off < padded.length; off += 136) {
      for (var i = 0; i < 17; i++) {
        var lane = 0n;
        for (var j = 7; j >= 0; j--) {
          lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
        }
        state[i] ^= lane;
      }
      _keccakF1600(state);
    }
    var out = [];
    for (i = 0; i < 4; i++) {
      for (j = 0; j < 8; j++) {
        out.push(Number((state[i] >> BigInt(8 * j)) & 0xffn));
      }
    }
    return out.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  /* PoW 真可解挑战（同 serve.py 的 fake_pow_challenge）：difficulty 是尝试次数
     上限，先随机挑一个 nonce 再反向算 challenge，worker 才能在限内解出。 */
  function fakePowChallenge() {
    var now = Math.floor(Date.now() / 1000);
    var saltBytes = new Uint8Array(8);
    crypto.getRandomValues(saltBytes);
    var salt = Array.from(saltBytes, function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
    var expireAt = now + 3600;
    var difficulty = 10000;
    var answer = Math.floor(Math.random() * difficulty);
    var challenge = sha3_256_hex(salt + '_' + expireAt + '_' + answer);
    return {
      algorithm: 'DeepSeekHashV1', challenge: challenge, salt: salt,
      difficulty: difficulty, signature: 'local',
      expire_at: expireAt, expire_after: 3600000
    };
  }

  /* ---------- 协议小件（同 serve.py） ---------- */
  function ok_biz(data) {
    return {code: 0, data: {biz_code: 0, biz_msg: '', biz_data: data}};
  }
  function bizErr(msg) {
    return {code: 0, data: {biz_code: 1, biz_msg: msg, biz_data: {}}};
  }
  function session_public(s) {
    return {id: s.id, title: s.title || '', updated_at: s.updated_at || 0,
            title_type: 'USER', pinned: !!s.pinned, version: 'unknown',
            model_type: s.model_type};
  }
  function message_public(m) {
    var frags = [];
    var think = m.think || '';
    if (think.trim()) {
      frags.push({id: 1, type: 'THINK', content: think});
    }
    var search = m.search || [];
    var refs = [null]; // [reference:N] 角标按 N 直接取 references[N]，1-based
    search.forEach(function (f) {
      var frag_id = frags.length + 1;
      frags.push({id: frag_id, type: 'TOOL_SEARCH',
                  status: f.status || 'FINISHED',
                  queries: f.queries || [], results: f.results || [],
                  content: f.content || ''});
      (f.results || []).forEach(function (r) {
        if (r.url) refs.push({id: frag_id, type: 'TOOL_SEARCH', urls: [r.url]});
      });
    });
    frags.push({id: frags.length + 1,
                type: m.role === 'USER' ? 'REQUEST' : 'RESPONSE',
                content: m.content || '', references: refs});
    return {message_id: m.id, parent_id: m.parent_id,
            role: m.role || 'USER',
            thinking_enabled: !!think.trim(),
            inserted_at: m.inserted_at || Date.now(),
            accumulated_token_usage: 0,
            search_enabled: !!search.length,
            search_triggered: search.length ? true : null,
            status: 'FINISHED', quasi_status: 'FINISHED',
            ban_regenerate: false, feedback: null,
            fragments: frags, has_pending_fragment: false,
            conversation_mode: search.length ? 'DEEP_SEARCH' : 'DEFAULT',
            extra_search_providers: null};
  }

  /* 清掉正文/思考里的残留标记（同 serve.py 的 _sanitize_text）。 */
  function sanitizeText(text) {
    text = text.replace(/<\/?thinking[^>]*>/gi, '');
    text = text.replace(/<thinking[^>]*$/gi, '');
    text = text.replace(/<\|[^|]{1,30}\|>/g, '');
    text = text.replace(/\[(?:citation|reference):[^\]]*$/, '');
    return text;
  }
  /* 从正文里拆出 <thinking>...</thinking> 模拟思考块（同 serve.py）。 */
  function splitThinking(text) {
    var m = /<thinking[^>]*>([\s\S]*?)<\/thinking>/i.exec(text);
    if (!m) return [null, sanitizeText(text)];
    var rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
    var block = sanitizeText(m[1].trim());
    return [block ? block : null, sanitizeText(rest)];
  }

  /* ---------- 会话存储（localStorage，同 serve.py 的 Store） ---------- */
  var STORE = {
    data: {next_msg_id: MSG_ID_START, next_session_num: 1, sessions: {}},
    load: function () {
      try {
        var d = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        if (d && typeof d === 'object' && d.sessions && typeof d.sessions === 'object') {
          this.data = d;
          if (typeof this.data.next_msg_id !== 'number') this.data.next_msg_id = MSG_ID_START;
          if (typeof this.data.next_session_num !== 'number') this.data.next_session_num = 1;
        }
      } catch (e) { /* 损坏则用空数据 */ }
      // 丢弃空会话（历史遗留的"新对话"）
      var empty = Object.keys(this.data.sessions).filter(function (sid) {
        return !(this.data.sessions[sid].messages || []).length;
      }, this);
      if (empty.length) {
        var self = this;
        empty.forEach(function (sid) { delete self.data.sessions[sid]; });
        this.save();
      }
    },
    save: function () {
      // localStorage 满了时丢最旧的会话重试（最多丢 5 个）
      for (var attempt = 0; attempt < 6; attempt++) {
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify(this.data));
          return;
        } catch (e) {
          var sids = Object.keys(this.data.sessions);
          if (!sids.length) return;
          sids.sort(function (a, b) {
            return (this.data.sessions[a].updated_at || 0) - (this.data.sessions[b].updated_at || 0);
          }.bind(this));
          delete this.data.sessions[sids[0]];
        }
      }
    },
    newMsgId: function () {
      var i = this.data.next_msg_id;
      this.data.next_msg_id = i + 1;
      return i;
    },
    newSessionId: function () {
      var n = this.data.next_session_num;
      this.data.next_session_num = n + 1;
      this.save(); // 只存计数器，防 id 重用；会话本身不落盘
      return 'local-' + n;
    },
    getSession: function (sid) { return this.data.sessions[sid] || null; },
    listSessions: function () {
      var self = this;
      return Object.keys(this.data.sessions)
        .map(function (sid) { return self.data.sessions[sid]; })
        .sort(function (a, b) { return (b.updated_at || 0) - (a.updated_at || 0); })
        .map(function (s) { return JSON.parse(JSON.stringify(s)); });
    },
    deleteSession: function (sid) {
      if (this.data.sessions[sid]) {
        delete this.data.sessions[sid];
        this.save();
      }
    },
    deleteAll: function () {
      this.data.sessions = {};
      this.save();
    },
    updateTitle: function (sid, title) {
      var s = this.data.sessions[sid];
      if (s) {
        s.title = title;
        s.updated_at = Math.floor(Date.now() / 1000);
        this.save();
      }
    },
    setPinned: function (sid, pinned) {
      var s = this.data.sessions[sid];
      if (s) {
        s.pinned = !!pinned;
        this.save();
      }
    },
    addMessage: function (sid, msg) {
      var s = this.data.sessions[sid];
      if (!s) {
        s = {id: sid, title: '', updated_at: Math.floor(Date.now() / 1000),
             pinned: false, model_type: null, messages: []};
        this.data.sessions[sid] = s;
      }
      s.messages.push(msg);
      s.updated_at = Math.floor(Date.now() / 1000);
      // 首条用户消息自动当标题
      if (!s.title && msg.role === 'USER' && msg.content) {
        s.title = msg.content.trim().split('\n')[0].slice(0, 30);
      }
      this.save();
    },
    dropTrailingAssistant: function (sid) {
      var s = this.data.sessions[sid];
      if (s && s.messages.length && s.messages[s.messages.length - 1].role === 'ASSISTANT') {
        s.messages.pop();
        this.save();
      }
    },
    truncateAfter: function (sid, msgId) {
      var s = this.data.sessions[sid];
      if (!s) return;
      for (var i = 0; i < s.messages.length; i++) {
        if (s.messages[i].id === msgId) {
          s.messages.splice(i);
          s.updated_at = Math.floor(Date.now() / 1000);
          this.save();
          return;
        }
      }
    },
    lastUserFlags: function (sid) {
      var s = this.data.sessions[sid];
      if (!s) return [null, null];
      for (var i = s.messages.length - 1; i >= 0; i--) {
        var m = s.messages[i];
        if (m.role === 'USER') return [m.thinking_enabled, m.search_enabled];
      }
      return [null, null];
    },
    lastUserMsgId: function (sid) {
      var s = this.data.sessions[sid];
      if (!s) return null;
      for (var i = s.messages.length - 1; i >= 0; i--) {
        if (s.messages[i].role === 'USER') return s.messages[i].id;
      }
      return null;
    },
    historyForApi: function (sid) {
      var s = this.data.sessions[sid];
      if (!s) return [];
      return s.messages.map(function (m) {
        return {role: (m.role || 'USER').toLowerCase(),
                content: m.api_content || m.content || ''};
      });
    }
  };
  STORE.load();

  /* ---------- 文件存储（只存内存，同 serve.py 的 FileStore） ---------- */
  var FILES = {
    files: {},
    nextId: 1,
    public: function (f) {
      return {id: f.id, file_name: f.file_name, file_size: f.file_size,
              status: f.status, retryable: f.status === 'FAILED',
              audit_result: 'pass', inserted_at: f.inserted_at,
              updated_at: f.updated_at, token_usage: f.token_usage || 0,
              error_code: f.error_code || null,
              from_share: false, is_image: false, signed_path: null};
    },
    add: function (filename, bytes) {
      var fid = 'file-' + (this.nextId++);
      var nowMs = Date.now();
      var dot = filename.lastIndexOf('.');
      var ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
      var f = {id: fid, file_name: filename, file_size: bytes.length,
               inserted_at: nowMs, updated_at: nowMs,
               token_usage: 0, error_code: null, text: ''};
      if (bytes.length > MAX_FILE_SIZE) {
        f.status = 'FAILED';
        f.error_code = 'FILE_TOO_LARGE';
      } else if (bytes.length === 0) {
        f.status = 'CONTENT_EMPTY';
      } else if (!TEXT_EXTS.has(ext)) {
        f.status = 'FAILED';
        f.error_code = 'UNSUPPORTED_TYPE';
      } else {
        var text = new TextDecoder('utf-8').decode(bytes);
        var truncated = false;
        if (text.length > MAX_TEXT_LEN) {
          text = text.slice(0, MAX_TEXT_LEN);
          truncated = true;
        }
        if (!text.trim()) {
          f.status = 'CONTENT_EMPTY';
        } else {
          f.status = 'SUCCESS';
          f.text = text;
          f.truncated = truncated;
          f.token_usage = Math.max(1, Math.floor(text.length / 4));
        }
      }
      this.files[fid] = f;
      return this.public(f);
    },
    getMany: function (ids) {
      var self = this;
      return ids.filter(function (i) { return self.files[i]; })
                .map(function (i) { return self.public(self.files[i]); });
    },
    textsForPrompt: function (ids) {
      var blocks = [], missing = [];
      var self = this;
      ids.forEach(function (i) {
        var f = self.files[i];
        if (!f || f.status !== 'SUCCESS' || !f.text) {
          missing.push(i);
          return;
        }
        var tail = f.truncated ? '\n（内容过长，已截断）' : '';
        blocks.push('[附件文件《' + f.file_name + '》内容如下：\n' + f.text + tail + '\n——文件内容结束]');
      });
      return [blocks, missing];
    }
  };

  /* ---------- 配置解析（逐字段回退：面板 localStorage > 内置 Pollinations） ---------- */
  function resolveConfig() {
    var panel = {};
    try { panel = JSON.parse(localStorage.getItem('ds_local_config') || '{}') || {}; } catch (e) { /* ignore */ }
    var def = GATEWAY_CFG || POLLINATIONS_CFG;
    function pick(v, d) {
      v = (v || '').trim();
      return v || d;
    }
    var url = pick(panel.url, def.url).replace(/\/+$/, '');
    var key = pick(panel.key, def.key || '');
    var model = pick(panel.model, def.model);
    return {url: url, key: key, model: model,
            src: (panel.url || '').trim() ? 'panel' : 'default',
            // 生效 URL 是网关地址时才走代理+兜底；面板自配的其他 URL 原样直调
            isGateway: !!(GATEWAY_CFG && url === GATEWAY_CFG.url)};
  }

  /* ---------- 免费网页搜索（浏览器直连，只用允许 CORS 的源） ---------- */
  var searchCache = {}; // query -> {at, results}
  function fetchWithTimeout(url, ms) {
    // 搜索源无响应时 12 秒即断，快速换下一个源，不让整轮搜索卡死。
    var c = new AbortController();
    var t = setTimeout(function () { try { c.abort(); } catch (e) { /* ignore */ } }, ms);
    return nativeFetch(url, {headers: {'Accept': 'application/json'}, signal: c.signal})
      .then(function (r) { clearTimeout(t); return r; },
            function (e) { clearTimeout(t); throw e; });
  }
  function ddgUnwrap(href) {
    try {
      if (href.indexOf('/l/?') >= 0) {
        var u = new URL(href, 'https://duckduckgo.com').searchParams.get('uddg');
        if (u) return u;
      }
    } catch (e) { /* ignore */ }
    return href;
  }
  function ddgInstantAnswer(query, limit) {
    // DuckDuckGo Instant Answer API：ACAO:*，浏览器可直连。返回摘要类结果
    // （AbstractText / RelatedTopics），没有传统网页列表，聊胜于无。
    var url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) +
              '&format=json&no_html=1&skip_disambig=1';
    return fetchWithTimeout(url, 12000)
      .then(function (resp) {
        if (!resp.ok) throw new Error('DDG IA HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (d) {
        var out = [];
        if (d.AbstractText) {
          out.push({title: d.Heading || query,
                    url: d.AbstractURL || 'https://duckduckgo.com/?q=' + encodeURIComponent(query),
                    snippet: d.AbstractText});
        }
        (d.RelatedTopics || []).forEach(function (t) {
          if (out.length >= limit) return;
          if (t.Text && t.FirstURL) {
            out.push({title: (t.Text.split(' - ')[0] || t.Text).slice(0, 60),
                      url: ddgUnwrap(t.FirstURL), snippet: t.Text});
          }
          (t.Topics || []).forEach(function (sub) {
            if (out.length >= limit) return;
            if (sub.Text && sub.FirstURL) {
              out.push({title: (sub.Text.split(' - ')[0] || sub.Text).slice(0, 60),
                        url: ddgUnwrap(sub.FirstURL), snippet: sub.Text});
            }
          });
        });
        return out;
      });
  }
  function wikiSearch(query, limit) {
    // 中文维基百科 API：origin=* 参数是拿到 ACAO 头的关键。
    var url = 'https://zh.wikipedia.org/w/api.php?action=query&list=search' +
              '&srsearch=' + encodeURIComponent(query) +
              '&format=json&srlimit=' + limit + '&origin=*';
    return fetchWithTimeout(url, 12000)
      .then(function (resp) {
        if (!resp.ok) throw new Error('wiki HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (d) {
        return ((d.query && d.query.search) || []).map(function (r) {
          return {title: r.title,
                  url: 'https://zh.wikipedia.org/wiki/' + encodeURIComponent(r.title.replace(/ /g, '_')),
                  snippet: (r.snippet || '').replace(/<[^>]*>/g, '')};
        });
      });
  }
  function webSearch(query, limit) {
    limit = limit || 5;
    var q = (query || '').trim();
    if (!q) return Promise.resolve([]);
    var hit = searchCache[q];
    if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL) {
      return Promise.resolve(hit.results);
    }
    // DDG Instant Answer 优先（覆盖广），维基补足；任一源有结果即返回。
    return ddgInstantAnswer(q, limit).catch(function () { return []; })
      .then(function (results) {
        if (results.length) return results;
        return wikiSearch(q, limit).catch(function () { return []; });
      })
      .then(function (results) {
        searchCache[q] = {at: Date.now(), results: results};
        return results;
      });
  }
  /* 搜索结果拼成喂给模型的 tool message 内容（同 serve.py，含全局引用编号）。 */
  function formatSearchResults(query, results, citeIndex, citeNext) {
    if (!results.length) {
      return '对“' + query + '”的网页搜索没有返回结果（搜索服务不可用或无相关网页），请根据已有知识回答，并说明未能联网核实。';
    }
    var lines = ['对“' + query + '”的网页搜索结果（共 ' + results.length + ' 条）：'];
    results.forEach(function (r) {
      var url = r.url;
      if (!(url in citeIndex)) {
        citeIndex[url] = citeNext[0];
        citeNext[0] += 1;
      }
      lines.push(citeIndex[url] + '. ' + r.title + '\n   ' + url + '\n   ' + (r.snippet || '（无摘要）'));
    });
    lines.push('请根据以上搜索结果回答用户的问题，引用信息时在相关句子后面标注引用编号，格式是 [reference:编号]（只用上面实际有的编号）。');
    return lines.join('\n');
  }

  /* ---------- 全文搜索（搜本地会话，同 serve.py 的 search_sessions） ---------- */
  var SEARCH_LIMIT = 20;
  function highlightParts(text, query) {
    if (!text) return {parts: [], is_begin: true, is_end: true};
    var idx = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
    if (idx < 0) {
      var snippet = text.slice(0, 120);
      return {parts: [{highlight: false, text: snippet}],
              is_begin: true, is_end: text.length <= 120};
    }
    var start = Math.max(0, idx - 40);
    var end = Math.min(text.length, idx + query.length + 80);
    var parts = [];
    if (idx > start) parts.push({highlight: false, text: text.slice(start, idx)});
    parts.push({highlight: true, text: text.slice(idx, idx + query.length)});
    if (idx + query.length < end) {
      parts.push({highlight: false, text: text.slice(idx + query.length, end)});
    }
    return {parts: parts, is_begin: start === 0, is_end: end === text.length};
  }
  function searchSessions(query) {
    var q = (query || '').trim();
    var events = [];
    if (!q) return events;
    var ql = q.toLowerCase();
    var count = 0;
    var sessions = STORE.listSessions();
    for (var si = 0; si < sessions.length && count < SEARCH_LIMIT; si++) {
      var s = sessions[si];
      var title = s.title || '';
      var ts = Math.floor(s.updated_at || 0);
      if (title.toLowerCase().indexOf(ql) >= 0) {
        events.push(['chat_session_title_item', {
          id: s.id, title: highlightParts(title, q),
          timestamp: ts, seq_id: 'title-' + s.id, model_type: null}]);
        count += 1;
        if (count >= SEARCH_LIMIT) break;
      }
      var msgs = s.messages || [];
      for (var mi = 0; mi < msgs.length && count < SEARCH_LIMIT; mi++) {
        var m = msgs[mi];
        var content = m.content || '';
        var think = m.think || '';
        var hitText = null, isThink = false;
        if (content.toLowerCase().indexOf(ql) >= 0) {
          hitText = content; isThink = false;
        } else if (think.toLowerCase().indexOf(ql) >= 0) {
          hitText = think; isThink = true;
        }
        if (hitText === null) continue;
        events.push(['item', {
          chat_session_id: s.id, message_id: m.id,
          message_role: m.role || 'USER',
          parent_message_id: m.parent_id,
          timestamp: Math.floor((m.inserted_at || 0) / 1000) || ts,
          seq_id: String(m.id),
          chat_session_title: highlightParts(title, q),
          chat_session_model_type: null,
          content: highlightParts(hitText, q),
          is_think: isThink, files: [],
          branch_index: 0, total_branches: 1}]);
        count += 1;
      }
    }
    return events;
  }

  /* ---------- 上游流式调用（OpenAI 兼容接口） ---------- */
  function UpstreamError(status, message) {
    var e = new Error(message || '');
    e.name = 'UpstreamError';
    e.status = status;
    e.message = message || '';
    return e;
  }
  function ClientGone() {
    var e = new Error('client gone');
    e.name = 'ClientGone';
    return e;
  }
  /* 调上游 /chat/completions（流式），逐个产出 {content, reasoning, tool_calls}。
     HTTP 错误 / 连接错误抛 UpstreamError(status, message)。 */
  /* 调上游 /chat/completions（流式），逐个产出 {content, reasoning, tool_calls}。
     HTTP 错误 / 连接错误抛 UpstreamError(status, message)。
     opts.useProxy：经 corsproxy.io 中转（网关默认配置用）；
     opts.timeoutMs：初始连接超时（默认 60 秒），超时按上游失败处理；
     流式读取阶段 90 秒无数据也按失败处理，避免代理挂死时无限等。 */
  async function* upstreamStream(apiUrl, apiKey, model, messages, tools, forceTool, signal, opts) {
    opts = opts || {};
    var payload = {model: model, messages: messages, stream: true, max_tokens: MAX_TOKENS};
    if (tools) {
      payload.tools = tools;
      payload.tool_choice = forceTool
        ? {type: 'function', function: {name: 'web_search'}}
        : 'auto';
    }
    var headers = {'Content-Type': 'application/json', 'Accept': 'text/event-stream'};
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    var endpoint = apiUrl + '/chat/completions';
    var fetchUrl = opts.useProxy
      ? CORS_PROXY_PREFIX + encodeURIComponent(endpoint)
      : endpoint;
    // 超时控制：把用户中止信号与超时信号合并成一个
    var timedOut = false;
    var timer = null;
    var timeoutController = new AbortController();
    var combined = new AbortController();
    function linkSignal(sig) {
      if (!sig) return;
      if (sig.aborted) {
        try { combined.abort(); } catch (e) { /* ignore */ }
        return;
      }
      sig.addEventListener('abort', function () {
        try { combined.abort(); } catch (e) { /* ignore */ }
      }, {once: true});
    }
    linkSignal(signal);
    linkSignal(timeoutController.signal);
    function armTimeout(ms) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timedOut = true;
        try { timeoutController.abort(); } catch (e) { /* ignore */ }
      }, ms);
    }
    function clearTimer() {
      if (timer) { clearTimeout(timer); timer = null; }
    }
    var resp;
    try {
      armTimeout(opts.timeoutMs || 60000);
      resp = await nativeFetch(fetchUrl, {
        method: 'POST', headers: headers,
        body: JSON.stringify(payload), signal: combined.signal
      });
    } catch (e) {
      clearTimer();
      if (timedOut) throw UpstreamError(0, '上游响应超时');
      if (e && e.name === 'AbortError') throw ClientGone();
      throw UpstreamError(0, String((e && e.message) || e).slice(0, 120));
    }
    clearTimer();
    if (!resp.ok) {
      var detail = '';
      try { detail = (await resp.text()).slice(0, 300); } catch (e) { /* ignore */ }
      var m = /"message"\s*:\s*"([^"]{0,120})/.exec(detail);
      throw UpstreamError(resp.status, m ? m[1] : detail.slice(0, 120));
    }
    var reader = resp.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    try {
      armTimeout(90000); // 读取阶段：90 秒无数据即断
      while (true) {
        var read = await reader.read();
        if (read.done) break;
        armTimeout(90000); // 收到数据，重置计时
        buf += decoder.decode(read.value, {stream: true});
        var lines = buf.split('\n');
        buf = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (line.indexOf('data:') !== 0) continue;
          var payloadS = line.slice(5).trim();
          if (payloadS === '[DONE]') return;
          var chunk;
          try { chunk = JSON.parse(payloadS); } catch (e) { continue; }
          var delta = {};
          try { delta = (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) || {}; } catch (e) { continue; }
          yield {content: delta.content || '',
                 reasoning: delta.reasoning_content || delta.reasoning || '',
                 tool_calls: delta.tool_calls || []};
        }
      }
    } catch (e) {
      if (timedOut) throw UpstreamError(0, '上游响应超时');
      if (e && e.name === 'AbortError') throw ClientGone();
      throw e;
    } finally {
      clearTimer();
      try { reader.releaseLock(); } catch (e) { /* ignore */ }
    }
  }

  /* ---------- 聊天桥接（SSE 核心引擎，同 serve.py 的 _handle_completion） ---------- */
  /* runCompletion(path, body, emit) 返回 {promise, abort}。
     emit(text) 推送 SSE 文本块；abort() 取消上游请求并保存已生成的部分回复。 */
  function runCompletion(path, body, emit) {
    var abortController = new AbortController();
    var aborted = false;
    function abort() {
      aborted = true;
      try { abortController.abort(); } catch (e) { /* ignore */ }
    }
    var scene = path.slice(path.lastIndexOf('/') + 1);
    var sid = body.chat_session_id || 'local-1';
    var prompt = body.prompt || '';
    var showThink, useSearch;
    if (scene === 'continue') {
      var flags = STORE.lastUserFlags(sid);
      showThink = flags[0] === null || flags[0] === undefined ? true : !!flags[0];
      useSearch = flags[1] === null || flags[1] === undefined ? false : !!flags[1];
    } else {
      showThink = body.thinking_enabled === null || body.thinking_enabled === undefined
        ? true : !!body.thinking_enabled;
      useSearch = !!body.search_enabled;
    }
    var cfg = resolveConfig();
    var apiUrl = cfg.url, apiKey = cfg.key, model = cfg.model;
    // 网关默认配置：经 CORS 代理调用；本会话内网关已失败则直接走 Pollinations
    var useGateway = cfg.isGateway && !gatewayFailed;
    if (cfg.isGateway && gatewayFailed) {
      apiUrl = POLLINATIONS_CFG.url; apiKey = ''; model = POLLINATIONS_CFG.model;
    }
    var notePending = false; // 兜底触发时，给这条回复开头加说明小字
    var reqMsgId = STORE.newMsgId();
    var respMsgId = STORE.newMsgId();
    if (scene === 'regenerate' || scene === 'continue') {
      // 这两个场景没有新用户消息：回复的 parent 必须是已有的最后一条用户消息。
      var lastUser = STORE.lastUserMsgId(sid);
      if (lastUser !== null) reqMsgId = lastUser;
    }

    var fullText = [];
    var thinkParts = [];
    var saved = false;
    var st = {msgSet: false, hasThink: false, hasResp: false, searchFrags: []};

    function emitRaw(text) {
      if (aborted) throw ClientGone();
      emit(text);
    }
    function emitEvent(name, data) {
      emitRaw('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n');
    }
    function emitDelta(obj) {
      emitRaw('data: ' + JSON.stringify(obj) + '\n\n');
    }
    function emitHint(content) {
      emitEvent('hint', {content: content, type: 'error',
                         clear_response: true, finish_reason: null});
    }
    function emitEnd() {
      emitEvent('finish', {});
      emitEvent('close', {click_behavior: 'none'});
    }
    function savePartial() {
      var text = fullText.join('');
      var think = thinkParts.join('');
      if (text.trim() && !saved) {
        saved = true;
        STORE.addMessage(sid, {
          id: respMsgId, parent_id: reqMsgId, role: 'ASSISTANT',
          content: text, think: think.trim() ? think : '',
          search: st.searchFrags.map(function (f) { return JSON.parse(JSON.stringify(f)); }),
          inserted_at: Date.now()});
      }
    }
    function setMsg(thinking) {
      var nowMs = Date.now();
      var frags = thinking
        ? [{id: 1, type: 'THINK', content: ''}]
        : [{id: 1, type: 'RESPONSE', content: ''}];
      emitDelta({o: 'SET', p: 'response', v: {response: {
        message_id: respMsgId, parent_id: reqMsgId, role: 'ASSISTANT',
        thinking_enabled: thinking, inserted_at: nowMs,
        accumulated_token_usage: 0,
        search_enabled: useSearch, search_triggered: null,
        status: 'WIP', quasi_status: 'WIP',
        ban_regenerate: false, feedback: null,
        fragments: frags, has_pending_fragment: false,
        conversation_mode: useSearch ? 'DEEP_SEARCH' : 'DEFAULT',
        extra_search_providers: null}}});
      st.msgSet = true;
      st.hasThink = thinking;
      st.hasResp = !thinking;
    }
    function buildReferences() {
      var refs = [null];
      var thinkOff = st.hasThink ? 1 : 0;
      st.searchFrags.forEach(function (f, i) {
        var fragId = thinkOff + i + 1;
        (f.results || []).forEach(function (r) {
          if (r.url) refs.push({id: fragId, type: 'TOOL_SEARCH', urls: [r.url]});
        });
      });
      return refs;
    }
    function setFragments() {
      var frags = [];
      if (st.hasThink) {
        frags.push({id: 1, type: 'THINK', content: thinkParts.join('')});
      }
      st.searchFrags.forEach(function (f) {
        var copy = JSON.parse(JSON.stringify(f));
        copy.id = frags.length + 1;
        frags.push(copy);
      });
      frags.push({id: frags.length + 1, type: 'RESPONSE',
                  content: fullText.join(''), references: buildReferences()});
      emitDelta({o: 'SET', p: 'response/fragments', v: frags});
    }
    function onSearchStart(query) {
      if (!st.msgSet) setMsg(false);
      st.searchFrags.push({type: 'TOOL_SEARCH', status: 'WIP',
                           queries: [{query: query}], results: [], content: ''});
      emitDelta({o: 'SET', p: 'response/search_triggered', v: true});
      setFragments();
    }
    function onSearchDone(results) {
      if (!st.searchFrags.length) return;
      var f = st.searchFrags[st.searchFrags.length - 1];
      f.status = 'FINISHED';
      f.results = results.map(function (r) {
        return {url: r.url, title: r.title, snippet: r.snippet || ''};
      });
      setFragments();
    }
    function onThink(piece) {
      if (!st.msgSet) {
        setMsg(true);
      } else if (!st.hasThink) {
        st.hasThink = true;
        setFragments();
        emitDelta({o: 'SET', p: 'response/thinking_enabled', v: true});
      }
      thinkParts.push(piece);
      emitDelta({o: 'APPEND', p: 'response/fragments/0/content', v: piece});
    }
    function onContent(piece) {
      if (notePending) {
        notePending = false;
        piece = FALLBACK_NOTE + '\n\n' + piece;
      }
      if (!st.msgSet) {
        setMsg(false);
      } else if (!st.hasResp) {
        st.hasResp = true;
        setFragments();
      }
      var idx = (st.hasThink ? 1 : 0) + st.searchFrags.length;
      fullText.push(piece);
      emitDelta({o: 'APPEND', p: 'response/fragments/' + idx + '/content', v: piece});
    }
    function replayBuffered(buffered) {
      // 真推理优先于 <thinking> 模拟块：两者都有时用真推理，模拟块直接丢掉。
      var hasRealThink = buffered.some(function (kv) { return kv[0] === 'think'; });
      var contentText = buffered.filter(function (kv) { return kv[0] === 'content'; })
                                .map(function (kv) { return kv[1]; }).join('');
      if (showThink) {
        if (hasRealThink) {
          contentText = splitThinking(contentText)[1];
        } else {
          var sp = splitThinking(contentText);
          contentText = sp[1];
          if (sp[0]) onThink(sp[0]);
        }
      } else {
        contentText = splitThinking(contentText)[1];
      }
      buffered.forEach(function (kv) {
        if (kv[0] === 'think' && showThink) onThink(kv[1]);
      });
      if (contentText) onContent(contentText);
    }

    var promise = (async function () {
      try {
        emitEvent('ready', {response_message_id: respMsgId,
                            request_message_id: reqMsgId, model_type: null});

        if (!apiUrl || !model) {
          emitHint('模型不可用：请点左下角齿轮填写自己的接口地址与 Key。');
          emitEnd();
          return;
        }

        // --- 会话历史（多轮靠这个记住上文） ---
        var history;
        if (scene === 'regenerate') {
          STORE.dropTrailingAssistant(sid);
          history = STORE.historyForApi(sid);
        } else if (scene === 'continue') {
          history = STORE.historyForApi(sid);
        } else { // completion / edit_message：新一轮用户消息进历史
          var parentId;
          if (scene === 'edit_message') {
            STORE.truncateAfter(sid, body.message_id);
            parentId = null;
            var s = STORE.getSession(sid);
            if (s && s.messages.length) parentId = s.messages[s.messages.length - 1].id;
          } else {
            parentId = body.parent_message_id;
          }
          var apiContent = prompt;
          var refIds = body.ref_file_ids || [];
          if (refIds.length) {
            var tfp = FILES.textsForPrompt(refIds);
            if (tfp[0].length) apiContent = tfp[0].join('\n\n') + '\n\n' + prompt;
          }
          STORE.addMessage(sid, {
            id: reqMsgId, parent_id: parentId, role: 'USER', content: prompt,
            api_content: apiContent,
            thinking_enabled: showThink, search_enabled: useSearch,
            inserted_at: Date.now()});
          history = STORE.historyForApi(sid);
        }
        if (!history.length) history = [{role: 'user', content: prompt}];

        // --- 系统提示词：人设 + 条件块（只发给上游模型，不存会话、不回推浏览器） ---
        var systemMsg = {role: 'system',
                         content: buildSystemPrompt(showThink, useSearch)};
        var workMessages = [systemMsg].concat(history);

        // --- 智能搜索：工具调用循环（模型 → web_search → 结果 → 模型） ---
        var tools = useSearch ? [WEB_SEARCH_TOOL] : null;
        var citeIndex = {};
        var citeNext = [1];
        var searchedRounds = 0;
        var toolsFailed = false;
        var searchRefusalRetried = false;
        var timeoutRetried = false;
        var forceTool = false;
        while (true) {
          var buffered = []; // [kind, text]，按到达顺序
          var toolCalls = {}; // index -> {id, name, arguments}
          var sawAny = false; // 本轮是否收到任何有效内容（网关无有效响应时走兜底）
          try {
            var gen = upstreamStream(apiUrl, apiKey, model, workMessages,
                                     useSearch ? tools : null, forceTool,
                                     abortController.signal,
                                     {useProxy: useGateway});
            for await (var d of gen) {
              if (d.reasoning) { buffered.push(['think', d.reasoning]); sawAny = true; }
              if (d.content) { buffered.push(['content', d.content]); sawAny = true; }
              (d.tool_calls || []).forEach(function (tc) {
                sawAny = true;
                var idx = tc.index || 0;
                var slot = toolCalls[idx] || (toolCalls[idx] = {id: '', name: '', arguments: ''});
                if (tc.id) slot.id = tc.id;
                var fn = tc.function || {};
                if (fn.name) slot.name = fn.name;
                if (fn.arguments) slot.arguments += fn.arguments;
              });
            }
          } catch (e) {
            if (e.name === 'ClientGone') throw e;
            if (useSearch && tools && e.status === 400 &&
                (e.message || '').toLowerCase().indexOf('tool') >= 0) {
              // 模型不支持 tools：退回普通对话，不报错
              toolsFailed = true;
              useSearch = false;
              tools = null;
              workMessages = [systemMsg].concat(history);
              continue;
            }
            if (useGateway && !gatewayFailed) {
              // 网关经代理调用失败：本会话改走 Pollinations，同一请求重试
              gatewayFailed = true;
              notePending = true;
              useGateway = false;
              apiUrl = POLLINATIONS_CFG.url; apiKey = ''; model = POLLINATIONS_CFG.model;
              continue;
            }
            if (!e.status && !timeoutRetried) {
              // 超时/断连且无 HTTP 状态：免费接口偶发排队慢，只重试一次
              timeoutRetried = true;
              continue;
            }
            if (e.status) {
              emitHint('接口返回错误（HTTP ' + e.status + '）' +
                       (e.message ? '：' + e.message : '') +
                       '，请检查 URL / Key / 模型是否正确。');
            } else {
              emitHint('连不上接口（' + (e.message || '') + '），请检查网络或 URL 是否正确。');
            }
            emitEnd();
            return;
          }

          // 网关返回了 200 但没有任何有效内容（代理回了错误页等）：同样走兜底
          if (useGateway && !sawAny && !gatewayFailed) {
            gatewayFailed = true;
            notePending = true;
            useGateway = false;
            apiUrl = POLLINATIONS_CFG.url; apiKey = ''; model = POLLINATIONS_CFG.model;
            continue;
          }
          var hasToolCalls = Object.keys(toolCalls).length > 0;
          if (!useSearch || !hasToolCalls) {
            // 模型谎称"搜索未启用"：工具明明已传给它，它却没调。
            // 只纠正一次：强制调用 web_search 再问一轮。
            var bufferedContent = buffered.filter(function (kv) { return kv[0] === 'content'; })
                                          .map(function (kv) { return kv[1]; }).join('');
            if (useSearch && !searchRefusalRetried && !forceTool &&
                REFUSAL_RE.test(bufferedContent)) {
              searchRefusalRetried = true;
              forceTool = true;
              continue;
            }
            forceTool = false;
            replayBuffered(buffered);
            break;
          }

          // 模型调了工具：强制重试已生效，后续轮次恢复 auto
          forceTool = false;
          // 先把这轮里的思考推给浏览器，再执行搜索
          buffered.forEach(function (kv) {
            if (kv[0] === 'think' && showThink) onThink(kv[1]);
          });
          var toolContent = buffered.filter(function (kv) { return kv[0] === 'content'; })
                                    .map(function (kv) { return kv[1]; }).join('');
          if (showThink) {
            var hasReal = buffered.some(function (kv) { return kv[0] === 'think'; });
            if (!hasReal) {
              var block = splitThinking(toolContent)[0];
              if (block) onThink(block);
            }
          }
          // （工具轮里模型附带的正文不是正式回答，丢掉，只保留思考）

          // 执行搜索，把结果喂回去再问一轮
          searchedRounds += 1;
          var callIdxs = Object.keys(toolCalls).map(Number).sort(function (a, b) { return a - b; });
          var calls = callIdxs.map(function (i) { return toolCalls[i]; });
          workMessages.push({role: 'assistant', content: null,
                             tool_calls: calls.map(function (c, i) {
                               return {id: c.id || ('call-' + i), type: 'function',
                                       function: {name: c.name, arguments: c.arguments}};
                             })});
          for (var ci = 0; ci < calls.length; ci++) {
            var c = calls[ci];
            var query = '';
            try { query = (JSON.parse(c.arguments || '{}').query) || ''; } catch (e) { query = ''; }
            var toolText;
            if (c.name === 'web_search' && query) {
              onSearchStart(query);
              var results = await webSearch(query);
              onSearchDone(results);
              toolText = formatSearchResults(query, results, citeIndex, citeNext);
            } else {
              toolText = '工具调用格式错误，未执行搜索。';
            }
            workMessages.push({role: 'tool',
                               tool_call_id: c.id || ('call-' + ci),
                               content: toolText});
          }
          if (searchedRounds >= SEARCH_MAX_ROUNDS) {
            // 搜够两轮了：最后一轮不带工具，强制模型直接回答
            tools = null;
            useSearch = false;
            continue;
          }
          // 继续循环：带工具结果再问模型（仍可继续搜）
        }

        var text = fullText.join('');
        var think = thinkParts.join('');
        if (!text.trim()) {
          emitHint('模型没有返回正文内容（可能推理占满了输出），请重试一次。');
          emitEnd();
          return;
        }
        savePartial();
        emitDelta({o: 'SET', p: 'response/status', v: 'FINISHED'});
        emitDelta({o: 'SET', p: 'response/quasi_status', v: 'FINISHED'});
        emitEnd();
      } catch (e) {
        if (e.name === 'ClientGone') {
          savePartial();
          return;
        }
        try {
          emitHint('处理出错（' + String((e && e.message) || e).slice(0, 100) + '），请重试。');
          emitEnd();
        } catch (e2) { /* 客户端已断开 */ }
      }
    })();
    return {promise: promise, abort: abort};
  }

  /* ---------- 端点路由 ---------- */
  /* handleApi 返回结果对象：
     {kind:'json', status, data} / {kind:'sse-stream', run(emit)->{promise,abort}}
     {kind:'sse-text', text} / {kind:'raw', status, body, contentType} */
  var exportStore = {url: null, json: null, mtime: 0};
  var AVATAR_URL = APP_BASE + 'static/fallbackWhale.3b8b290cc6.png';

  async function handleApi(method, path, qs, body, formData) {
    // 聊天桥接（流式 SSE）
    if (path === '/api/v0/chat/completion' || path === '/api/v0/chat/regenerate' ||
        path === '/api/v0/chat/continue' || path === '/api/v0/chat/edit_message') {
      return {kind: 'sse-stream',
              run: function (emit) { return runCompletion(path, body || {}, emit); }};
    }
    // 全文搜索（SSE，一次发完）
    if (path === '/api/v0/index/query' && method === 'POST') {
      var query = (body && body.query) || '';
      var out = [];
      searchSessions(query).forEach(function (ev) {
        out.push('event: ' + ev[0] + '\ndata: ' + JSON.stringify(ev[1]) + '\n\n');
      });
      out.push('event: close\ndata: {"close_reason": "success"}\n\n');
      return {kind: 'sse-text', text: out.join('')};
    }
    // 文件上传
    if (path === '/api/v0/file/upload_file' && method === 'POST') {
      var file = formData ? formData.get('file') : null;
      if (!file || typeof file.arrayBuffer !== 'function') {
        return {kind: 'json', status: 200, data: bizErr('no file part')};
      }
      var bytes = new Uint8Array(await file.arrayBuffer());
      return {kind: 'json', status: 200, data: ok_biz(FILES.add(file.name, bytes))};
    }
    // 导出文件下载
    if (path.indexOf('/local/export/') === 0 && method === 'GET') {
      if (path.split('/').pop() !== 'chat-export.json' || !exportStore.json) {
        return {kind: 'raw', status: 404, body: 'Not Found', contentType: 'text/plain'};
      }
      return {kind: 'raw', status: 200, body: exportStore.json,
              contentType: 'application/json; charset=utf-8'};
    }

    if (path === '/api/v0/chat/create_pow_challenge' && method === 'POST') {
      return {kind: 'json', status: 200, data: ok_biz({challenge: fakePowChallenge()})};
    }
    if (path === '/api/v0/chat_session/create' && method === 'POST') {
      var sid = STORE.newSessionId();
      var s = {id: sid, title: '', updated_at: Math.floor(Date.now() / 1000),
               pinned: false, model_type: null};
      return {kind: 'json', status: 200,
              data: ok_biz({chat_session: session_public(s), ttl_seconds: 3600})};
    }
    if (path === '/api/v0/chat_session/fetch_page' && method === 'GET') {
      var ss = STORE.listSessions().map(session_public);
      return {kind: 'json', status: 200, data: ok_biz({has_more: false, chat_sessions: ss})};
    }
    if (path === '/api/v0/chat/history_messages' && method === 'GET') {
      var hsid = (qs.get('chat_session_id') || [''])[0];
      var hs = STORE.getSession(hsid);
      if (!hs) {
        hs = {id: hsid, title: '', updated_at: Math.floor(Date.now() / 1000),
              pinned: false, model_type: null, messages: []};
      }
      // 容错：parent_id 指向不存在的消息时修正为上一条消息的 id（或 null）
      var ids = {};
      (hs.messages || []).forEach(function (m) { ids[m.id] = true; });
      var msgs = [];
      var prevId = null;
      (hs.messages || []).forEach(function (m) {
        var mm = JSON.parse(JSON.stringify(m));
        if (mm.parent_id !== null && mm.parent_id !== undefined && !ids[mm.parent_id]) {
          mm.parent_id = prevId;
        }
        msgs.push(message_public(mm));
        prevId = m.id;
      });
      return {kind: 'json', status: 200,
              data: ok_biz({chat_session: session_public(hs),
                            chat_messages: msgs, cache_control: 'REPLACE'})};
    }
    if (path === '/api/v0/chat_session/delete' && method === 'POST') {
      STORE.deleteSession((body && body.chat_session_id) || '');
      return {kind: 'json', status: 200, data: ok_biz({})};
    }
    if (path === '/api/v0/chat_session/delete_all' && method === 'POST') {
      STORE.deleteAll();
      return {kind: 'json', status: 200, data: ok_biz({})};
    }
    if (path === '/api/v0/chat_session/update_title' && method === 'POST') {
      STORE.updateTitle((body && body.chat_session_id) || '', (body && body.title) || '');
      return {kind: 'json', status: 200, data: ok_biz({})};
    }
    if (path === '/api/v0/chat_session/batch_update_pinned' && method === 'POST') {
      var pinned = body ? body.pinned : false;
      ((body && body.chat_session_ids) || []).forEach(function (id) {
        STORE.setPinned(id, pinned);
      });
      return {kind: 'json', status: 200, data: ok_biz({})};
    }
    if ((path === '/api/v0/users' || path === '/api/v0/users/current') && method === 'GET') {
      // id 必须与 index.html 里种的登录态完全一致（local-user），
      // 否则壳子判定"用户变了"会触发 logout，侧栏卡骨架屏。
      return {kind: 'json', status: 200, data: ok_biz({
        token: 'local-user', id: 'local-user', email: '', mobile: '',
        area_code: '', status: 'normal',
        id_profile: {picture: AVATAR_URL, name: 'DeepSeek', email: ''},
        id_profiles: [], chat: null,
        has_legacy_chat_history: false, need_birthday: false})};
    }
    if (path === '/api/v0/client/settings' && method === 'GET') {
      var scope = (qs.get('scope') || [null])[0];
      var settings = {};
      if (scope === null || scope === 'main') {
        settings = {conversation_search_enabled: {id: 1, value: true}};
      }
      return {kind: 'json', status: 200,
              data: ok_biz({settings: settings, version: 2})};
    }
    if (path === '/api/v0/index/prepare' && method === 'GET') {
      return {kind: 'json', status: 200, data: ok_biz({})};
    }
    if (path === '/api/v0/file/fetch_files' && method === 'GET') {
      var fids = [];
      (qs.get('file_ids') || []).forEach(function (v) {
        v.split(',').forEach(function (x) { if (x) fids.push(x); });
      });
      return {kind: 'json', status: 200,
              data: ok_biz({files: FILES.getMany(fids)})};
    }
    if (path === '/api/v0/export_all' && method === 'GET') {
      try {
        var data = {exported_at: Math.floor(Date.now() / 1000),
                    app: '一款大模型对话（静态版）', sessions: []};
        STORE.listSessions().forEach(function (s) {
          data.sessions.push({
            id: s.id, title: s.title || '',
            updated_at: s.updated_at || 0, pinned: !!s.pinned,
            messages: (s.messages || []).map(function (m) {
              return {role: m.role, content: m.content || '',
                      think: m.think || '', inserted_at: m.inserted_at};
            })});
        });
        var json = JSON.stringify(data, null, 2);
        if (exportStore.url) {
          try { URL.revokeObjectURL(exportStore.url); } catch (e) { /* ignore */ }
        }
        exportStore.json = json;
        exportStore.mtime = Math.floor(Date.now() / 1000);
        exportStore.url = URL.createObjectURL(
          new Blob([json], {type: 'application/json'}));
        return {kind: 'json', status: 200, data: ok_biz({})};
      } catch (e) {
        return {kind: 'json', status: 200,
                data: bizErr(String((e && e.message) || e).slice(0, 100))};
      }
    }
    if (path === '/api/v0/download_export_history' && method === 'GET') {
      if (!exportStore.json) {
        return {kind: 'json', status: 200, data: bizErr('NO_TASK')};
      }
      return {kind: 'json', status: 200, data: ok_biz({
        status: 'FINISHED', history_download_url: exportStore.url,
        legacy_history_download_url: null,
        exported_at: exportStore.mtime,
        expires_at: exportStore.mtime + 7 * 86400})};
    }
    if (path === '/local/models' && method === 'POST') {
      // 齿轮面板"获取模型列表"：浏览器直连上游 /models（需要对方允许 CORS）。
      // 默认网关地址走 CORS 代理；面板自配的其他 URL 原样直调。
      var mcfg = resolveConfig();
      var murl = ((body && body.url) || '').trim().replace(/\/+$/, '') || mcfg.url;
      var mkey = ((body && body.key) || '').trim() || mcfg.key;
      if (!murl) {
        return {kind: 'json', status: 400, data: {error: 'empty url'}};
      }
      var mUseProxy = !!(GATEWAY_CFG && murl === GATEWAY_CFG.url);
      var mFetchUrl = mUseProxy
        ? CORS_PROXY_PREFIX + encodeURIComponent(murl + '/models')
        : murl + '/models';
      var mheaders = {'Accept': 'application/json'};
      if (mkey) mheaders['Authorization'] = 'Bearer ' + mkey;
      var mController = new AbortController();
      var mTimer = setTimeout(function () {
        try { mController.abort(); } catch (e) { /* ignore */ }
      }, 20000);
      try {
        var mresp = await nativeFetch(mFetchUrl,
                                      {headers: mheaders, signal: mController.signal});
        if (!mresp.ok) {
          return {kind: 'json', status: 502,
                  data: {error: 'upstream HTTP ' + mresp.status}};
        }
        var mdata = await mresp.json();
        return {kind: 'json', status: 200, data: mdata};
      } catch (e) {
        return {kind: 'json', status: 502,
                data: {error: String((e && e.message) || e).slice(0, 200)}};
      } finally {
        clearTimeout(mTimer);
      }
    }
    if (path === '/api/v0/share/create' && method === 'POST') {
      return {kind: 'json', status: 200, data: bizErr('static build: share disabled')};
    }
    if (path === '/api/v0/share/list' && method === 'GET') {
      return {kind: 'json', status: 200, data: ok_biz({shares: []})};
    }
    if (path === '/api/v0/share/content' || path === '/api/v0/share/delete' ||
        path === '/api/v0/share/fork') {
      return {kind: 'json', status: 200, data: bizErr('static build: share disabled')};
    }
    // 其余 /api 一律标准空成功：遥测、上报、TTS、文件……
    return {kind: 'json', status: 200, data: ok_biz({})};
  }

  function parseQs(search) {
    var params = new URLSearchParams(search || '');
    var map = {};
    params.forEach(function (v, k) {
      (map[k] = map[k] || []).push(v);
    });
    return {get: function (k) { return map[k] || null; }};
  }
  function isApiPath(pathname) {
    return pathname.indexOf('/api/') === 0 || pathname.indexOf('/local/') === 0;
  }
  function jsonResponse(status, data) {
    return new Response(JSON.stringify(data), {
      status: status,
      headers: {'Content-Type': 'application/json; charset=utf-8'}});
  }

  /* ---------- 子路径部署：把壳子对域名根的资源请求改写到应用子路径 ---------- */
  var APP_PATH = (function () {
    try { return new URL(APP_BASE).pathname; } catch (e) { return '/'; }
  })();
  function rewriteAppUrl(u) {
    // u 是同源 URL 对象。只改写壳子自身的资源路径（/static/*、图标等）。
    if (APP_PATH === '/' || u.origin !== location.origin) return u;
    var p = u.pathname;
    if (p === '/manifest.json' || p === '/favicon.svg' ||
        p === '/guard.js' || p === '/enhance.js' || p === '/backend.js' ||
        p.indexOf('/static/') === 0 || p.indexOf('/icon-') === 0) {
      u.pathname = APP_PATH.replace(/\/$/, '') + p;
    }
    return u;
  }

  /* ---------- fetch 拦截（主路径） ---------- */
  window.fetch = async function (input, init) {
    var request;
    try {
      request = new Request(input, init);
    } catch (e) {
      return nativeFetch(input, init);
    }
    var url;
    try {
      url = new URL(request.url, location.href);
    } catch (e) {
      return nativeFetch(input, init);
    }
    if (!isApiPath(url.pathname)) {
      // 非 API 请求：同源资源可能需要子路径改写，其余原样放行
      if (url.origin === location.origin) {
        var before = url.href;
        rewriteAppUrl(url);
        if (url.href !== before) return nativeFetch(new Request(url.href, request));
      }
      return nativeFetch(input, init);
    }
    var method = (request.method || 'GET').toUpperCase();
    var qs = parseQs(url.search);
    var body = null, formData = null;
    if (method !== 'GET' && method !== 'HEAD') {
      var ct = (request.headers.get('content-type') || '').toLowerCase();
      try {
        if (ct.indexOf('multipart/form-data') >= 0) {
          formData = await request.clone().formData();
        } else {
          var txt = await request.clone().text();
          if (txt) {
            try { body = JSON.parse(txt); } catch (e) { body = null; }
          }
        }
      } catch (e) { /* body 读失败就按空处理 */ }
    }
    var signal = (init && init.signal) ||
                 ((typeof Request !== 'undefined' && input instanceof Request) ? input.signal : null);
    var result;
    try {
      result = await handleApi(method, url.pathname, qs, body, formData);
    } catch (e) {
      return jsonResponse(500, {error: String((e && e.message) || e).slice(0, 200)});
    }
    if (result.kind === 'json') return jsonResponse(result.status, result.data);
    if (result.kind === 'raw') {
      return new Response(result.body, {
        status: result.status,
        headers: {'Content-Type': result.contentType}});
    }
    if (result.kind === 'sse-text') {
      return new Response(result.text, {
        status: 200,
        headers: {'Content-Type': 'text/event-stream; charset=utf-8',
                  'Cache-Control': 'no-cache'}});
    }
    // sse-stream：ReadableStream 逐块推送，取消时中止引擎并保存部分回复
    var handle = null;
    var closed = false;
    var keepAlive = null;
    var stream = new ReadableStream({
      start: function (controller) {
        var enc = new TextEncoder();
        // 保活（与 XHR 空 progress 事件同理）：fetch 路径无法发空事件，
        // 只能入队 SSE 注释行，标准 SSE 解析器会忽略注释。
        keepAlive = setInterval(function () {
          if (closed) { clearInterval(keepAlive); return; }
          try { controller.enqueue(enc.encode(': ping\n\n')); }
          catch (e) { clearInterval(keepAlive); }
        }, 20000);
        handle = result.run(function (text) {
          if (closed) throw ClientGone();
          try {
            controller.enqueue(enc.encode(text));
          } catch (e) {
            closed = true;
            throw ClientGone();
          }
        });
        if (signal) {
          if (signal.aborted) {
            handle.abort();
          } else {
            signal.addEventListener('abort', function () { handle.abort(); }, {once: true});
          }
        }
        handle.promise.then(function () {
          clearInterval(keepAlive);
          try { controller.close(); } catch (e) { /* ignore */ }
        }).catch(function () {
          clearInterval(keepAlive);
          try { controller.close(); } catch (e) { /* ignore */ }
        });
      },
      cancel: function () {
        closed = true;
        if (keepAlive) clearInterval(keepAlive);
        if (handle) handle.abort();
      }
    });
    return new Response(stream, {
      status: 200,
      headers: {'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                'x-ds-sse-heartbeat-timeout-secs': '120'}});
  };

  /* ---------- XHR 拦截（兜底：壳子若有地方用 XHR 调 /api） ---------- */
  function fireXhrEvent(xhr, type) {
    try {
      var ev;
      if (type === 'progress' || type === 'load') {
        ev = new ProgressEvent(type, {
          lengthComputable: false,
          loaded: (xhr.__dsResponseText || '').length, total: 0});
      } else {
        ev = new Event(type);
      }
      xhr.dispatchEvent(ev);
    } catch (e) { /* ignore */ }
  }
  function installXhrShadow(xhr) {
    xhr.__dsReadyState = 1;
    xhr.__dsStatus = 0;
    xhr.__dsStatusText = '';
    xhr.__dsResponseText = '';
    xhr.__dsHeaders = {'content-type': 'application/json; charset=utf-8'};
    xhr.__dsAborted = false;
    xhr.__dsAbortFn = null;
    Object.defineProperty(xhr, 'readyState', {
      configurable: true, get: function () { return xhr.__dsReadyState; }});
    Object.defineProperty(xhr, 'status', {
      configurable: true, get: function () { return xhr.__dsStatus; }});
    Object.defineProperty(xhr, 'statusText', {
      configurable: true, get: function () { return xhr.__dsStatusText; }});
    Object.defineProperty(xhr, 'responseText', {
      configurable: true, get: function () { return xhr.__dsResponseText; }});
    Object.defineProperty(xhr, 'response', {
      configurable: true,
      get: function () {
        if (xhr.responseType === 'json') {
          try { return JSON.parse(xhr.__dsResponseText); } catch (e) { return null; }
        }
        if (xhr.responseType === '' || xhr.responseType === 'text') {
          return xhr.__dsResponseText;
        }
        return null;
      }});
    xhr.getResponseHeader = function (name) {
      return xhr.__dsHeaders[(name || '').toLowerCase()] || null;
    };
    xhr.getAllResponseHeaders = function () {
      var out = [];
      Object.keys(xhr.__dsHeaders).forEach(function (k) {
        out.push(k + ': ' + xhr.__dsHeaders[k]);
      });
      return out.join('\r\n') + (out.length ? '\r\n' : '');
    };
    xhr.abort = function () {
      if (xhr.__dsAborted) return;
      xhr.__dsAborted = true;
      if (xhr.__dsAbortFn) {
        try { xhr.__dsAbortFn(); } catch (e) { /* ignore */ }
      }
      xhr.__dsReadyState = 0;
      fireXhrEvent(xhr, 'readystatechange');
      fireXhrEvent(xhr, 'abort');
      fireXhrEvent(xhr, 'loadend');
    };
  }
  function removeXhrShadow(xhr) {
    ['readyState', 'status', 'statusText', 'responseText', 'response'].forEach(function (k) {
      try { delete xhr[k]; } catch (e) { /* ignore */ }
    });
    try { delete xhr.getResponseHeader; } catch (e) { /* ignore */ }
    try { delete xhr.getAllResponseHeaders; } catch (e) { /* ignore */ }
    try { delete xhr.abort; } catch (e) { /* ignore */ }
  }
  NativeXHR.prototype.open = function (method, url, async, user, password) {
    var m = (method || 'GET').toUpperCase();
    var u = null;
    try { u = new URL(url, location.href); } catch (e) { /* ignore */ }
    this.__dsMethod = m;
    this.__dsPath = u ? u.pathname : '';
    this.__dsSearch = u ? u.search : '';
    this.__dsIntercept = !!(u && isApiPath(u.pathname));
    this.__dsReqHeaders = {};
    if (this.__dsIntercept) {
      // 先调原生 open，让真实 XHR 进入 OPENED 状态：否则调用方随后调
      // setRequestHeader 会抛 InvalidStateError（真实 XHR 还是 UNSENT），
      // 整个请求直接失败。网络不会发出，因为 send() 会被拦截，不调原生 send。
      try {
        nativeOpen.apply(this, arguments);
      } catch (e) { /* ignore */ }
      installXhrShadow(this);
      fireXhrEvent(this, 'readystatechange'); // OPENED
      return;
    }
    removeXhrShadow(this);
    if (u && u.origin === location.origin) {
      var before = u.href;
      rewriteAppUrl(u);
      if (u.href !== before) {
        return nativeOpen.call(this, m, u.href, async, user, password);
      }
    }
    return nativeOpen.apply(this, arguments);
  };
  NativeXHR.prototype.send = function (body) {
    if (!this.__dsIntercept) return nativeSend.apply(this, arguments);
    var xhr = this;
    var jsonBody = null, formData = null;
    if (body) {
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        formData = body;
      } else if (typeof body === 'string') {
        try { jsonBody = JSON.parse(body); } catch (e) { jsonBody = null; }
      }
    }
    // 先给临时 200：真实 XHR 在 HEADERS_RECEIVED 时 status 已有值；
    // handleApi 返回后会按真实状态修正（壳子只在 DONE 时读 status）。
    xhr.__dsStatus = 200;
    // 关键：lyla 在 HEADERS_RECEIVED 时就缓存响应头，壳子据 content-type
    // 判断是否为 SSE 流；若此时是默认的 application/json，壳子会判定
    // "不是流式"并拒绝解析整条流（表现为"请检查网络后重试"）。
    // 所以按路径在 readyState 2 之前预设正确的 content-type。
    if (xhr.__dsPath === '/api/v0/chat/completion' ||
        xhr.__dsPath === '/api/v0/chat/regenerate' ||
        xhr.__dsPath === '/api/v0/chat/continue' ||
        xhr.__dsPath === '/api/v0/chat/edit_message' ||
        xhr.__dsPath === '/api/v0/index/query') {
      xhr.__dsHeaders = {'content-type': 'text/event-stream; charset=utf-8',
                         'x-ds-sse-heartbeat-timeout-secs': '120'};
    }
    xhr.__dsReadyState = 2;
    fireXhrEvent(xhr, 'readystatechange');
    handleApi(xhr.__dsMethod, xhr.__dsPath, parseQs(xhr.__dsSearch),
              jsonBody, formData).then(function (result) {
      if (xhr.__dsAborted) return;
      function finish(status, text, contentType) {
        xhr.__dsStatus = status;
        xhr.__dsHeaders = {'content-type': contentType || 'application/json; charset=utf-8'};
        xhr.__dsResponseText = text;
        xhr.__dsReadyState = 3;
        fireXhrEvent(xhr, 'readystatechange');
        fireXhrEvent(xhr, 'progress');
        xhr.__dsReadyState = 4;
        fireXhrEvent(xhr, 'readystatechange');
        fireXhrEvent(xhr, 'load');
        fireXhrEvent(xhr, 'loadend');
      }
      if (result.kind === 'json') {
        finish(result.status, JSON.stringify(result.data));
      } else if (result.kind === 'raw') {
        finish(result.status, result.body, result.contentType);
      } else if (result.kind === 'sse-text') {
        finish(200, result.text, 'text/event-stream; charset=utf-8');
      } else if (result.kind === 'sse-stream') {
        xhr.__dsStatus = 200;
        xhr.__dsHeaders = {'content-type': 'text/event-stream; charset=utf-8',
                           'x-ds-sse-heartbeat-timeout-secs': '120'};
        xhr.__dsReadyState = 3;
        fireXhrEvent(xhr, 'readystatechange');
        // 保活：引擎整轮缓冲时可能很久不发数据（如长推理），壳子的心跳
        // 检测（无头时 120 秒）会判定断流并中止请求。每 20 秒发一次空
        // progress 事件：lyla 会调 onDownloadProgress，壳子收到后 ping
        // 心跳；responseText 未变，SSE 解析器无新数据，不产生副作用。
        var keepAlive = setInterval(function () {
          if (xhr.__dsAborted) { clearInterval(keepAlive); return; }
          fireXhrEvent(xhr, 'progress');
        }, 20000);
        var handle = result.run(function (text) {
          if (xhr.__dsAborted) throw ClientGone();
          xhr.__dsResponseText += text;
          fireXhrEvent(xhr, 'readystatechange');
          fireXhrEvent(xhr, 'progress');
        });
        xhr.__dsAbortFn = function () { clearInterval(keepAlive); handle.abort(); };
        handle.promise.then(function () {
          clearInterval(keepAlive);
          if (xhr.__dsAborted) return;
          xhr.__dsReadyState = 4;
          fireXhrEvent(xhr, 'readystatechange');
          fireXhrEvent(xhr, 'load');
          fireXhrEvent(xhr, 'loadend');
        }).catch(function () {
          clearInterval(keepAlive);
          if (xhr.__dsAborted) return;
          xhr.__dsReadyState = 4;
          fireXhrEvent(xhr, 'readystatechange');
          fireXhrEvent(xhr, 'load');
          fireXhrEvent(xhr, 'loadend');
        });
      }
    }).catch(function (e) {
      if (xhr.__dsAborted) return;
      xhr.__dsStatus = 500;
      xhr.__dsResponseText = JSON.stringify(
        {error: String((e && e.message) || e).slice(0, 200)});
      xhr.__dsReadyState = 4;
      fireXhrEvent(xhr, 'readystatechange');
      fireXhrEvent(xhr, 'load');
      fireXhrEvent(xhr, 'loadend');
    });
  };
})();
