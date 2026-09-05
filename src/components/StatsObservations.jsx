import { useState, useMemo } from 'react';

function fmt(n) { return Number(n || 0).toLocaleString(); }
function fmtK(n) { return n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n||0); }

function getMonthKey(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d)) return null;
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  } catch { return null; }
}
function monthLabel(key) {
  const [y,m] = key.split('-');
  return new Date(+y,+m-1,1).toLocaleDateString('en-US',{month:'short',year:'2-digit'});
}
function monthLabelFull(key) {
  const [y,m] = key.split('-');
  return new Date(+y,+m-1,1).toLocaleDateString('en-US',{month:'long',year:'numeric'});
}
function smoothPath(pts) {
  if (pts.length < 2) return pts.length===1?`M${pts[0].x},${pts[0].y}`:'';
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i=0;i<pts.length-1;i++) {
    const cp1x=pts[i].x+(pts[i+1].x-pts[i].x)/3;
    const cp2x=pts[i].x+(pts[i+1].x-pts[i].x)*2/3;
    d+=` C${cp1x},${pts[i].y} ${cp2x},${pts[i+1].y} ${pts[i+1].x},${pts[i+1].y}`;
  }
  return d;
}
function areaPath(pts,h) {
  if (!pts.length) return '';
  return `${smoothPath(pts)} L${pts[pts.length-1].x},${h} L${pts[0].x},${h} Z`;
}

const PAL = ['#1d9bf0','#a855f7','#f59e0b','#10b981','#f91880','#00ba7c','#ff7b54','#60a5fa','#34d399','#c084fc'];

function SectionTitle({ children }) {
  return <div className="stats-section-title" style={{marginTop:32,marginBottom:14,fontSize:13,display:'flex',alignItems:'center',gap:10}}>{children}</div>;
}

export default function StatsObservations({ bookmarks, onClose }) {
  const [timeRange, setTimeRange]   = useState('all');
  const [selectedMonth, setSelectedMonth] = useState(null);
  const [hoveredPt, setHoveredPt]   = useState(null);

  // ── by sync month ─────────────────────────────────────────────────────────
  const bySyncMonth = useMemo(()=>{
    const m={};
    bookmarks.forEach(b=>{
      const k=getMonthKey(b.bookmarkedAt||b.syncedAt);
      if(!k)return;
      if(!m[k])m[k]=[];
      m[k].push(b);
    });
    return m;
  },[bookmarks]);

  const byTweetMonth = useMemo(()=>{
    const m={};
    bookmarks.forEach(b=>{
      const k=getMonthKey(b.postedAt);
      if(!k)return;
      if(!m[k])m[k]=[];
      m[k].push(b);
    });
    return m;
  },[bookmarks]);

  const allSyncMonths = useMemo(()=>Object.keys(bySyncMonth).sort(),[bySyncMonth]);
  const allTweetMonths = useMemo(()=>Object.keys(byTweetMonth).sort(),[byTweetMonth]);

  const filteredMonths = useMemo(()=>{
    if(timeRange==='all')return allSyncMonths;
    const now=new Date();
    const n=timeRange==='1y'?12:timeRange==='6m'?6:3;
    const cut=new Date(now.getFullYear(),now.getMonth()-n+1,1);
    const cutK=`${cut.getFullYear()}-${String(cut.getMonth()+1).padStart(2,'0')}`;
    return allSyncMonths.filter(k=>k>=cutK);
  },[allSyncMonths,timeRange]);

  // ── categories ───────────────────────────────────────────────────────────
  const catCounts = useMemo(()=>{
    const c={};
    bookmarks.forEach(b=>{if(b.primaryCategory&&b.primaryCategory!=='unclassified')c[b.primaryCategory]=(c[b.primaryCategory]||0)+1;});
    return Object.entries(c).sort((a,b)=>b[1]-a[1]);
  },[bookmarks]);
  const topCats=catCounts.slice(0,8);
  const top5cats=catCounts.slice(0,5).map(([c])=>c);
  const maxCatCount=topCats[0]?.[1]||1;

  // category trend by tweet date
  const catTrend = useMemo(()=>{
    const months=allTweetMonths.slice(-18);
    return months.map(key=>{
      const bms=byTweetMonth[key]||[];
      const row={key};
      top5cats.forEach(cat=>{row[cat]=bms.filter(b=>b.primaryCategory===cat).length;});
      return row;
    });
  },[catCounts,allTweetMonths,byTweetMonth]);

  // ── category trend chart points ──────────────────────────────────────────
  const catChartW=680, catChartH=200, catPadL=36, catPadR=16, catPadT=16, catPadB=28;
  const catInnerW=catChartW-catPadL-catPadR, catInnerH=catChartH-catPadT-catPadB;

  const catChartLines = useMemo(()=>{
    const months = catTrend; // last 18 tweet-date months
    if (months.length < 2) return [];
    const maxVal = Math.max(...months.flatMap(row => top5cats.map(c => row[c]||0)), 1);
    return top5cats.map((cat, ci) => {
      const pts = months.map((row, i) => ({
        x: catPadL + (i / Math.max(months.length-1, 1)) * catInnerW,
        y: catPadT + catInnerH - ((row[cat]||0) / maxVal) * catInnerH,
        count: row[cat]||0,
        key: row.key,
      }));
      return { cat, color: PAL[ci], pts, maxVal };
    });
  }, [catTrend, top5cats]);

  const [hoveredCatPt, setHoveredCatPt] = useState(null); // {cat, key}

  // ── domains ───────────────────────────────────────────────────────────────
  const topDomains = useMemo(()=>{
    const d={};
    bookmarks.forEach(b=>{if(b.primaryDomain)d[b.primaryDomain]=(d[b.primaryDomain]||0)+1;});
    return Object.entries(d).sort((a,b)=>b[1]-a[1]).slice(0,10);
  },[bookmarks]);

  // ── authors ───────────────────────────────────────────────────────────────
  const topAuthors = useMemo(()=>{
    const a={},m={};
    bookmarks.forEach(b=>{
      if(!b.authorHandle)return;
      a[b.authorHandle]=(a[b.authorHandle]||0)+1;
      if(!m[b.authorHandle])m[b.authorHandle]={name:b.authorName,img:b.authorProfileImageUrl};
    });
    return Object.entries(a).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([h,c])=>({handle:h,count:c,...m[h]}));
  },[bookmarks]);

  // ── engagement ────────────────────────────────────────────────────────────
  const eng = useMemo(()=>{
    const totalLikes=bookmarks.reduce((s,b)=>s+(b.likeCount||0),0);
    const totalReposts=bookmarks.reduce((s,b)=>s+(b.repostCount||0),0);
    const totalBm=bookmarks.reduce((s,b)=>s+(b.bookmarkCount||0),0);
    const withLikes=bookmarks.filter(b=>b.likeCount>0);
    const avgLikes=withLikes.length?Math.round(totalLikes/withLikes.length):0;
    const topLiked=[...bookmarks].sort((a,b)=>(b.likeCount||0)-(a.likeCount||0)).slice(0,5);
    const topBm=[...bookmarks].sort((a,b)=>(b.bookmarkCount||0)-(a.bookmarkCount||0)).slice(0,5);
    return{totalLikes,totalReposts,totalBm,avgLikes,topLiked,topBm};
  },[bookmarks]);

  // ── read / misc ───────────────────────────────────────────────────────────
  const readStats = useMemo(()=>{
    const read=bookmarks.filter(b=>b.isRead).length;
    const rate=bookmarks.length?Math.round(read/bookmarks.length*100):0;
    const unread=bookmarks.filter(b=>!b.isRead);
    const oldest=[...unread].sort((a,b)=>new Date(a.bookmarkedAt||a.syncedAt)-new Date(b.bookmarkedAt||b.syncedAt))[0];
    return{read,rate,unread:unread.length,oldest,
      withNotes:bookmarks.filter(b=>b.note).length,
      withLabels:bookmarks.filter(b=>b.colorLabel).length,
      withFav:bookmarks.filter(b=>b.favFolder).length};
  },[bookmarks]);

  const misc = useMemo(()=>{
    const avgLen=Math.round(bookmarks.reduce((s,b)=>s+(b.text||'').split(' ').length,0)/(bookmarks.length||1));
    const uniqueAuthors=new Set(bookmarks.map(b=>b.authorHandle).filter(Boolean)).size;
    const years=[...new Set(bookmarks.map(b=>b.postedAt&&new Date(b.postedAt).getFullYear()).filter(Boolean))];
    const span=years.length?Math.max(...years)-Math.min(...years)+1:0;
    return{avgLen,withLinks:bookmarks.filter(b=>(b.linkCount||0)>0).length,
      withMedia:bookmarks.filter(b=>(b.mediaCount||0)>0).length,
      uniqueAuthors,diversityPct:Math.round(uniqueAuthors/bookmarks.length*100),span};
  },[bookmarks]);

  // ── posting hour ──────────────────────────────────────────────────────────
  const hourDist = useMemo(()=>{
    const h=Array(24).fill(0);
    bookmarks.forEach(b=>{try{if(b.postedAt)h[new Date(b.postedAt).getUTCHours()]++;}catch{}});
    const max=Math.max(...h,1);
    return h.map((count,hour)=>({hour,count,pct:count/max}));
  },[bookmarks]);
  const peakHour=hourDist.reduce((m,h)=>h.count>m.count?h:m,{count:0,hour:0});

  // ── SVG chart ─────────────────────────────────────────────────────────────
  const chartW=680,chartH=160,padL=36,padR=16,padT=14,padB=28;
  const innerW=chartW-padL-padR,innerH=chartH-padT-padB;
  const chartPts = useMemo(()=>{
    if(!filteredMonths.length)return[];
    const max=Math.max(...filteredMonths.map(k=>bySyncMonth[k]?.length||0),1);
    return filteredMonths.map((k,i)=>({key:k,count:bySyncMonth[k]?.length||0,
      x:padL+(i/Math.max(filteredMonths.length-1,1))*innerW,
      y:padT+innerH-((bySyncMonth[k]?.length||0)/max)*innerH}));
  },[filteredMonths,bySyncMonth]);
  const maxCount=chartPts.length?Math.max(...chartPts.map(p=>p.count)):0;

  const selectedData = useMemo(()=>{
    if(!selectedMonth||!bySyncMonth[selectedMonth])return null;
    const items=bySyncMonth[selectedMonth];
    const cats={},domains={};
    items.forEach(b=>{
      if(b.primaryCategory)cats[b.primaryCategory]=(cats[b.primaryCategory]||0)+1;
      if(b.primaryDomain)domains[b.primaryDomain]=(domains[b.primaryDomain]||0)+1;
    });
    return{items,
      topCats:Object.entries(cats).sort((a,b)=>b[1]-a[1]).slice(0,5),
      topDomains:Object.entries(domains).sort((a,b)=>b[1]-a[1]).slice(0,4)};
  },[selectedMonth,bySyncMonth]);

  return (
    <div className="mode-container">
      <div className="mode-topbar">
        <button className="mode-back-btn" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          Back
        </button>
        <h2 className="mode-title">Stats &amp; Observations</h2>
      </div>

      <div className="stats-body">

        {/* ── 1. Headline KPIs ── */}
        <SectionTitle>At a glance</SectionTitle>
        <div className="stats-kpi-grid">
          {[
            {v:fmt(bookmarks.length),     l:'Total Bookmarks'},
            {v:fmt(misc.uniqueAuthors),   l:'Unique Voices'},
            {v:`${misc.span}y`,           l:'Tweet Span'},
            {v:`${readStats.rate}%`,      l:'Read Rate'},
            {v:fmtK(eng.totalLikes),      l:'Likes Captured'},
            {v:fmt(catCounts.length),     l:'Categories'},
            {v:`${misc.diversityPct}%`,   l:'Author Diversity'},
            {v:fmt(misc.withLinks),       l:'Have Links'},
            {v:fmt(readStats.withFav),    l:'Favourited'},
            {v:fmt(readStats.withNotes),  l:'Annotated'},
            {v:fmtK(eng.avgLikes),        l:'Avg Likes/Post'},
            {v:fmt(misc.withMedia),       l:'Have Media'},
          ].map(({v,l})=>(
            <div key={l} className="stats-kpi">
              <div className="stats-kpi-val">{v}</div>
              <div className="stats-kpi-label">{l}</div>
            </div>
          ))}
        </div>

        {/* ── 2. Timeline by save date ── */}
        <SectionTitle>
          Bookmarks saved over time
          <div className="stats-range-btns">
            {[['all','All'],['1y','1Y'],['6m','6M'],['3m','3M']].map(([k,l])=>(
              <button key={k} className={`sort-btn ${timeRange===k?'active':''}`} onClick={()=>{setTimeRange(k);setSelectedMonth(null);}}>{l}</button>
            ))}
          </div>
        </SectionTitle>
        <div className="stats-chart-wrap">
          <svg className="stats-svg" viewBox={`0 0 ${chartW} ${chartH}`} preserveAspectRatio="none">
            {[0,0.25,0.5,0.75,1].map((t,i)=>{
              const y=padT+t*innerH;
              return <g key={i}>
                <line x1={padL} x2={chartW-padR} y1={y} y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>
                <text x={padL-4} y={y+4} fill="var(--text-tertiary)" fontSize="9" textAnchor="end">{Math.round(maxCount*(1-t))}</text>
              </g>;
            })}
            {chartPts.length>1&&(<>
              <defs>
                <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.25"/>
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"/>
                </linearGradient>
              </defs>
              <path d={areaPath(chartPts,padT+innerH)} fill="url(#cg)"/>
              <path d={smoothPath(chartPts)} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/>
            </>)}
            {chartPts.map((pt,i)=>(
              <g key={pt.key}>
                <circle cx={pt.x} cy={pt.y} r={hoveredPt===pt.key?5:3}
                  fill={selectedMonth===pt.key?'#fff':'var(--accent)'}
                  stroke={selectedMonth===pt.key?'var(--accent)':'var(--bg)'}
                  strokeWidth="2" style={{cursor:'pointer',transition:'r 0.1s'}}
                  onClick={()=>setSelectedMonth(pt.key===selectedMonth?null:pt.key)}
                  onMouseEnter={()=>setHoveredPt(pt.key)}
                  onMouseLeave={()=>setHoveredPt(null)}
                />
                {hoveredPt===pt.key&&(
                  <g>
                    <rect x={pt.x-24} y={pt.y-28} width="48" height="18" rx="5" fill="var(--bg-elevated)" stroke="var(--border)"/>
                    <text x={pt.x} y={pt.y-15} fill="var(--text-primary)" fontSize="10" textAnchor="middle" fontWeight="600">{pt.count}</text>
                  </g>
                )}
                {(i===0||i===filteredMonths.length-1||filteredMonths.length<=12||i%Math.ceil(filteredMonths.length/10)===0)&&(
                  <text x={pt.x} y={padT+innerH+16} fill="var(--text-tertiary)" fontSize="8" textAnchor="middle">{monthLabel(pt.key)}</text>
                )}
              </g>
            ))}
          </svg>
        </div>

        {selectedMonth&&selectedData&&(
          <div className="stats-detail" style={{marginTop:12}}>
            <div className="stats-detail-header">
              <span className="stats-detail-title">{monthLabelFull(selectedMonth)}</span>
              <span className="stats-detail-count">{selectedData.items.length} bookmarks</span>
              <button className="stats-detail-close" onClick={()=>setSelectedMonth(null)}>✕</button>
            </div>
            <div className="stats-detail-grid">
              <div className="stats-detail-card">
                <div className="stats-detail-card-title">Top Categories</div>
                {selectedData.topCats.map(([cat,n])=>(
                  <div key={cat} className="stats-detail-row">
                    <span className="stats-detail-label">{cat}</span>
                    <span className="stats-detail-val">{n}</span>
                  </div>
                ))}
              </div>
              <div className="stats-detail-card">
                <div className="stats-detail-card-title">Top Domains</div>
                {selectedData.topDomains.map(([d,n])=>(
                  <div key={d} className="stats-detail-row">
                    <span className="stats-detail-label">{d}</span>
                    <span className="stats-detail-val">{n}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── 3. Categories by volume ── */}
        <SectionTitle>Top categories by volume</SectionTitle>
        <div className="stats-cat-bars">
          {topCats.map(([cat,count],i)=>(
            <div key={cat} className="stats-cat-row">
              <div className="stats-cat-name">{cat}</div>
              <div className="stats-cat-bar-wrap">
                <div className="stats-cat-bar-fill" style={{width:`${count/maxCatCount*100}%`,background:PAL[i%PAL.length]}}/>
              </div>
              <div className="stats-cat-count">{fmt(count)}</div>
              <div className="stats-cat-pct">{Math.round(count/bookmarks.length*100)}%</div>
            </div>
          ))}
        </div>

        {/* ── 4. Category growth by tweet date — multi-line chart ── */}
        <SectionTitle>Category growth by tweet date — top 5</SectionTitle>
        <div className="stats-chart-wrap">
          {/* Legend */}
          <div className="stats-cat-legend">
            {catChartLines.map(({cat, color}) => (
              <div key={cat} className="stats-cat-legend-item">
                <span className="stats-cat-legend-dot" style={{background: color}}/>
                {cat}
              </div>
            ))}
          </div>

          <svg className="stats-svg" style={{height: catChartH}} viewBox={`0 0 ${catChartW} ${catChartH}`} preserveAspectRatio="none">
            {/* Y-axis grid lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
              const y = catPadT + t * catInnerH;
              const val = catChartLines[0] ? Math.round(catChartLines[0].maxVal * (1 - t)) : 0;
              return (
                <g key={i}>
                  <line x1={catPadL} x2={catChartW - catPadR} y1={y} y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1"/>
                  <text x={catPadL - 4} y={y + 4} fill="var(--text-tertiary)" fontSize="9" textAnchor="end">{val}</text>
                </g>
              );
            })}

            {/* One line per category */}
            {catChartLines.map(({cat, color, pts}) => (
              <g key={cat}>
                {/* Area fill under line */}
                <defs>
                  <linearGradient id={`cg-${cat}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="0.15"/>
                    <stop offset="100%" stopColor={color} stopOpacity="0"/>
                  </linearGradient>
                </defs>
                {pts.length > 1 && (
                  <path d={areaPath(pts, catPadT + catInnerH)} fill={`url(#cg-${cat})`}/>
                )}
                {pts.length > 1 && (
                  <path d={smoothPath(pts)} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeOpacity="0.85"/>
                )}
                {/* Dots — only where count > 0 */}
                {pts.filter(p => p.count > 0).map(pt => (
                  <g key={pt.key}>
                    <circle
                      cx={pt.x} cy={pt.y}
                      r={hoveredCatPt?.cat === cat && hoveredCatPt?.key === pt.key ? 5 : 3}
                      fill={color} stroke="var(--bg)" strokeWidth="1.5"
                      style={{cursor: 'default', transition: 'r 0.1s'}}
                      onMouseEnter={() => setHoveredCatPt({cat, key: pt.key, count: pt.count, x: pt.x, y: pt.y})}
                      onMouseLeave={() => setHoveredCatPt(null)}
                    />
                  </g>
                ))}
              </g>
            ))}

            {/* Tooltip for hovered point */}
            {hoveredCatPt && (() => {
              const tx = hoveredCatPt.x;
              const ty = hoveredCatPt.y;
              const label = `${hoveredCatPt.cat}: ${hoveredCatPt.count}`;
              const boxW = label.length * 6 + 16;
              const bx = Math.min(tx - boxW / 2, catChartW - catPadR - boxW);
              return (
                <g style={{pointerEvents: 'none'}}>
                  <rect x={Math.max(catPadL, bx)} y={ty - 30} width={boxW} height={20} rx="5" fill="var(--bg-elevated)" stroke="var(--border)"/>
                  <text x={Math.max(catPadL, bx) + boxW / 2} y={ty - 16} fill="var(--text-primary)" fontSize="10" textAnchor="middle" fontWeight="600">
                    {label}
                  </text>
                </g>
              );
            })()}

            {/* X-axis labels — month names */}
            {catChartLines[0]?.pts.map((pt, i) => {
              const months = catTrend;
              const show = months.length <= 14 || i === 0 || i === months.length - 1 || i % Math.ceil(months.length / 10) === 0;
              return show ? (
                <text key={pt.key} x={pt.x} y={catPadT + catInnerH + 16} fill="var(--text-tertiary)" fontSize="8" textAnchor="middle">
                  {monthLabel(pt.key)}
                </text>
              ) : null;
            })}
          </svg>
        </div>

        {/* ── 5. Engagement ── */}
        <SectionTitle>Engagement captured</SectionTitle>
        <div className="stats-kpi-grid" style={{gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))'}}>
          {[
            {v:fmtK(eng.totalLikes),   l:'Total Likes'},
            {v:fmtK(eng.totalReposts), l:'Total Reposts'},
            {v:fmtK(eng.totalBm),      l:'Re-Bookmarked'},
            {v:fmtK(eng.avgLikes),     l:'Avg Likes / Post'},
          ].map(({v,l})=>(
            <div key={l} className="stats-kpi"><div className="stats-kpi-val">{v}</div><div className="stats-kpi-label">{l}</div></div>
          ))}
        </div>

        <SectionTitle>Most liked in your collection</SectionTitle>
        {eng.topLiked.map((b,i)=>(
          <a key={b.id} href={b.url} target="_blank" rel="noopener noreferrer" className="stats-eng-row">
            <span className="stats-eng-rank">#{i+1}</span>
            <div className="stats-eng-body">
              <div className="stats-eng-author">@{b.authorHandle}</div>
              <div className="stats-eng-text">{(b.text||'').slice(0,120)}…</div>
            </div>
            <div className="stats-eng-likes">♥ {fmtK(b.likeCount)}</div>
          </a>
        ))}

        <SectionTitle>Most bookmarked by others</SectionTitle>
        {eng.topBm.map((b,i)=>(
          <a key={b.id} href={b.url} target="_blank" rel="noopener noreferrer" className="stats-eng-row">
            <span className="stats-eng-rank">#{i+1}</span>
            <div className="stats-eng-body">
              <div className="stats-eng-author">@{b.authorHandle}</div>
              <div className="stats-eng-text">{(b.text||'').slice(0,120)}…</div>
            </div>
            <div className="stats-eng-likes" style={{color:'var(--bookmark)'}}>🔖 {fmtK(b.bookmarkCount)}</div>
          </a>
        ))}

        {/* ── 6. Top voices ── */}
        <SectionTitle>Top voices by saves</SectionTitle>
        {topAuthors.map((a,i)=>(
          <div key={a.handle} className="stats-author-row">
            <span className="stats-eng-rank">#{i+1}</span>
            {a.img&&<img className="stats-author-img" src={a.img} alt="" onError={e=>e.target.style.display='none'}/>}
            <div className="stats-eng-body">
              <div className="stats-eng-author">{a.name||a.handle}</div>
              <div style={{fontSize:12,color:'var(--text-secondary)'}}>@{a.handle}</div>
            </div>
            <div className="stats-eng-likes" style={{color:'var(--text-secondary)'}}>{a.count} saves</div>
          </div>
        ))}

        {/* ── 7. Posting hour heatmap ── */}
        <SectionTitle>When were these tweets posted? (UTC — peak {peakHour.hour}:00)</SectionTitle>
        <div className="stats-hour-grid">
          {hourDist.map(({hour,count,pct})=>(
            <div key={hour} className="stats-hour-bar" title={`${hour}:00 UTC — ${count} tweets`}>
              <div className="stats-hour-fill" style={{height:`${Math.max(pct*100,2)}%`,opacity:0.35+pct*0.65}}/>
              {hour%6===0&&<div className="stats-hour-label">{hour}h</div>}
            </div>
          ))}
        </div>

        {/* ── 8. Top domains ── */}
        <SectionTitle>Top domains in your collection</SectionTitle>
        <div className="stats-domain-list">
          {topDomains.map(([domain,count],i)=>(
            <div key={domain} className="stats-domain-row">
              <span className="stats-eng-rank">#{i+1}</span>
              <span className="stats-domain-name">{domain}</span>
              <div className="stats-domain-bar-wrap">
                <div className="stats-domain-bar" style={{width:`${count/(topDomains[0]?.[1]||1)*100}%`}}/>
              </div>
              <span className="stats-domain-count">{count}</span>
            </div>
          ))}
        </div>

        {/* ── 9. Content + reading patterns ── */}
        <SectionTitle>Content &amp; reading patterns</SectionTitle>
        <div className="stats-kpi-grid">
          {[
            {v:misc.avgLen+'w',        l:'Avg Tweet Length'},
            {v:fmt(misc.withLinks),    l:'Have Links'},
            {v:fmt(misc.withMedia),    l:'Have Media'},
            {v:fmt(readStats.withFav), l:'Favourited'},
            {v:fmt(readStats.withNotes),l:'Annotated'},
            {v:fmt(readStats.withLabels),l:'Colour Labelled'},
            {v:`${readStats.rate}%`,   l:'Read'},
            {v:fmt(readStats.unread),  l:'Unread'},
          ].map(({v,l})=>(
            <div key={l} className="stats-kpi"><div className="stats-kpi-val">{v}</div><div className="stats-kpi-label">{l}</div></div>
          ))}
        </div>

        {readStats.oldest&&(
          <>
            <SectionTitle>Oldest unread bookmark</SectionTitle>
            <a href={readStats.oldest.url} target="_blank" rel="noopener noreferrer" className="stats-oldest-link">
              <span style={{fontSize:12,color:'var(--accent)'}}>@{readStats.oldest.authorHandle}</span>
              <span style={{fontSize:13,color:'var(--text-primary)',lineHeight:1.5}}>{(readStats.oldest.text||'').slice(0,160)}…</span>
              <span style={{fontSize:11,color:'var(--text-tertiary)'}}>
                Bookmarked {new Date(readStats.oldest.bookmarkedAt||readStats.oldest.syncedAt).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}
              </span>
            </a>
          </>
        )}

        <div style={{height:40}}/>
      </div>
    </div>
  );
}
