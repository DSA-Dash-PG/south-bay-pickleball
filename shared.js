// ═══════════════════════════════════════════════════════
//  SOUTH BAY PICKLEBALL LEAGUE — shared.js v4
//  Multi-season, multi-division, captain portal
// ═══════════════════════════════════════════════════════

const SUPABASE_URL = 'https://hltnrnanunwsbxaylshx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhsdG5ybmFudW53c2J4YXlsc2h4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5NjA5ODgsImV4cCI6MjA5MTUzNjk4OH0.6YBXFQmxlaGK2-fChhLuLsjzF48BLvnQPZxAj_aahDk';

// ── Supabase REST helpers ──────────────────────────────
function authHeaders(extra={}) {
  const token = localStorage.getItem('sbpl_access_token');
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${token || SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function sbFetch(path, opts={}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { ...authHeaders(), 'Prefer': opts.prefer||'return=representation', ...(opts.headers||{}) }
  });
  if (!res.ok) { const e=await res.text(); console.error('sb error',res.status,e); return null; }
  if (res.status===204) return true;
  return res.json();
}

const sb = {
  select: (t,q='*',f='') => sbFetch(`${t}?select=${q}${f?'&'+f:''}`),
  insert: (t,d)  => sbFetch(t, {method:'POST', body:JSON.stringify(d)}),
  update: (t,d,f)=> sbFetch(`${t}?${f}`, {method:'PATCH', body:JSON.stringify(d)}),
  upsert: (t,d)  => sbFetch(t, {method:'POST', body:JSON.stringify(d), prefer:'resolution=merge-duplicates,return=representation', headers:{'Prefer':'resolution=merge-duplicates,return=representation'}}),
  delete: (t,f)  => sbFetch(`${t}?${f}`, {method:'DELETE', prefer:''})
};

// ── Auth ──────────────────────────────────────────────
async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method:'POST',
    headers:{'apikey':SUPABASE_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({email,password})
  });
  const d = await res.json();
  if (!res.ok) return {error: d.error_description||d.msg||'Login failed'};
  localStorage.setItem('sbpl_access_token',  d.access_token);
  localStorage.setItem('sbpl_refresh_token', d.refresh_token);
  localStorage.setItem('sbpl_user_id',       d.user.id);
  localStorage.setItem('sbpl_user_email',    d.user.email);
  return {user: d.user};
}

async function signOut() {
  const token = localStorage.getItem('sbpl_access_token');
  if (token) await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
    method:'POST', headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${token}`}
  });
  ['sbpl_access_token','sbpl_refresh_token','sbpl_user_id','sbpl_user_email',
   'sbpl_player_id','sbpl_team_id','sbpl_role'].forEach(k=>localStorage.removeItem(k));
}

async function sendPasswordReset(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
    method:'POST',
    headers:{'apikey':SUPABASE_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({email})
  });
  return res.ok;
}

async function updatePassword(newPassword) {
  const token = localStorage.getItem('sbpl_access_token');
  if (!token) return {error:'Not authenticated'};
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method:'PUT',
    headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({password:newPassword})
  });
  const d = await res.json();
  if (!res.ok) return {error: d.error_description||'Update failed'};
  return {success:true};
}

async function signUp(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method:'POST',
    headers:{'apikey':SUPABASE_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({email,password})
  });
  const d = await res.json();
  if (!res.ok) return {error: d.error_description||d.msg||'Signup failed'};
  return {user: d.user||d};
}

async function handleAuthRedirect() {
  const hash = window.location.hash;
  if (!hash) return null;
  const p = new URLSearchParams(hash.substring(1));
  const token = p.get('access_token');
  const type  = p.get('type');
  if (token) {
    localStorage.setItem('sbpl_access_token', token);
    history.replaceState(null,'',window.location.pathname);
    return type; // 'recovery' | 'signup' | etc.
  }
  return null;
}

function isLoggedIn()  { return !!localStorage.getItem('sbpl_access_token'); }
function getSession()  { return { token:localStorage.getItem('sbpl_access_token'), email:localStorage.getItem('sbpl_user_email'), userId:localStorage.getItem('sbpl_user_id') }; }

// ── Role resolution ───────────────────────────────────
// Returns: 'superadmin' | 'admin' | 'captain' | 'player' | null
async function resolveRole() {
  const {userId, email} = getSession();
  if (!userId) return null;
  // Check admins table
  const admRow = await sb.select('admins','role',`auth_user_id=eq.${userId}`);
  if (admRow && admRow.length) return admRow[0].role; // superadmin | admin
  // Check if captain
  const capRow = await sb.select('players','id',`auth_user_id=eq.${userId}`);
  if (capRow && capRow.length) {
    localStorage.setItem('sbpl_player_id', capRow[0].id);
    const teamRow = await sb.select('teams','id,division_id',`captain_id=eq.${capRow[0].id}&status=eq.active`);
    if (teamRow && teamRow.length) {
      localStorage.setItem('sbpl_team_id', teamRow[0].id);
      return 'captain';
    }
    return 'player';
  }
  return null;
}

// ── Cache ─────────────────────────────────────────────
const C={};
function cSet(k,v,ms=30000){C[k]={v,exp:Date.now()+ms};}
function cGet(k){const e=C[k];return e&&Date.now()<e.exp?e.v:null;}

// ── Toast ─────────────────────────────────────────────
function toast(msg,err){
  const t=document.getElementById('toast');if(!t)return;
  t.textContent=msg;t.className='toast'+(err?' error':'')+' show';
  setTimeout(()=>t.classList.remove('show'),3500);
}

// ── Nav ───────────────────────────────────────────────
function markActiveNav(){
  const file=window.location.pathname.split('/').pop()||'index.html';
  document.querySelectorAll('[data-page]').forEach(a=>{
    const p=a.getAttribute('data-page');
    const map={home:'index.html',teams:'teams.html',standings:'standings.html',
      schedule:'schedule.html',stats:'stats.html',funtimes:'funtimes.html',
      rules:'rules.html',players:'players.html',register:'register.html',
      contact:'contact.html',admin:'admin.html',captain:'captain.html'};
    if(map[p]===file||(file===''&&p==='home'))a.classList.add('active');
  });
}

// ── SEASONS ───────────────────────────────────────────
async function getSeasons() {
  const cached = cGet('seasons');
  if (cached) return cached;
  const rows = await sb.select('seasons','*','order=created_at.desc');
  const data = rows||[];
  cSet('seasons',data);
  return data;
}

async function getActiveSeason() {
  const seasons = await getSeasons();
  return seasons.find(s=>s.status==='active') || seasons.find(s=>s.status==='upcoming') || seasons[0] || null;
}

// ── DIVISIONS ─────────────────────────────────────────
async function getDivisions(seasonId) {
  const key = `divs_${seasonId}`;
  const cached = cGet(key);
  if (cached) return cached;
  const rows = await sb.select('divisions','*',`season_id=eq.${seasonId}&order=gender.asc,age_group.asc,skill_level.asc`);
  const data = rows||[];
  cSet(key,data);
  return data;
}

function groupDivisions(divisions) {
  // Groups by age_group then gender
  const groups = {};
  const order = ['open','40plus','junior'];
  const genderLabel = {ladies:'Ladies',mens:'Mens',mixed:'Mixed',junior:'Junior'};
  const ageLabel = {open:'Open','-40plus':'40+','junior':'Junior'};
  divisions.forEach(d=>{
    const ag = d.age_group==='40plus' ? '40+' : d.age_group==='junior' ? 'Junior' : 'Open';
    const key = ag;
    if (!groups[key]) groups[key]=[];
    groups[key].push(d);
  });
  return groups;
}

// ── TEAMS ─────────────────────────────────────────────
async function getTeamsByDivision(divisionId) {
  const key = `teams_div_${divisionId}`;
  const cached = cGet(key);
  if (cached) return cached;
  const rows = await sb.select('teams','*,players(first,last,avatar_url)',`division_id=eq.${divisionId}&status=neq.withdrawn&order=name.asc`);
  const data = rows||[];
  cSet(key,data,15000);
  return data;
}

async function getTeamWithRoster(teamId) {
  const rows = await sb.select(
    'teams',
    '*, team_players(*, players(*))',
    `id=eq.${teamId}`
  );
  return rows&&rows[0] || null;
}

// ── MATCHES ───────────────────────────────────────────
async function getMatchesByDivision(divisionId) {
  const key = `matches_div_${divisionId}`;
  const cached = cGet(key);
  if (cached) return cached;
  const rows = await sb.select('matches','*',`division_id=eq.${divisionId}&order=week_index.asc`);
  const data = rows||[];
  cSet(key,data,15000);
  return data;
}

async function saveMatch(matchId, data) {
  const payload = {
    team1_id: data.team1_id,
    team2_id: data.team2_id,
    rounds:   data.rounds,
    status:   'completed',
    played_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    entered_by: data.entered_by||null
  };
  let result;
  if (matchId) {
    result = await sb.update('matches', payload, `id=eq.${matchId}`);
  } else {
    result = await sb.insert('matches', {
      ...payload,
      division_id: data.division_id,
      season_id:   data.season_id,
      week_index:  data.week_index,
      week_id:     data.week_id||null
    });
  }
  // Bust cache
  delete C[`matches_div_${data.division_id}`];
  return result;
}

// ── SCHEDULE ──────────────────────────────────────────
async function getScheduleByDivision(divisionId) {
  const key = `sched_div_${divisionId}`;
  const cached = cGet(key);
  if (cached) return cached;
  const rows = await sb.select('schedule_weeks','*',`division_id=eq.${divisionId}&order=week_index.asc`);
  const data = rows||[];
  cSet(key,data);
  return data;
}

// ── STANDINGS (computed) ──────────────────────────────
function computeStandings(teams, matches) {
  const tm={};
  teams.forEach(t=>{tm[t.id]={team:t.name,teamId:t.id,color:t.color,rds:0,w:0,l:0,t:0,pts:0,gw:0,gl:0,ps:0,pa:0,diff:0};});
  matches.forEach(m=>{
    if(!m.team1_id||!m.team2_id||!m.rounds||!m.rounds.length) return;
    const t1=tm[m.team1_id], t2=tm[m.team2_id];
    if(!t1||!t2) return;
    let mw1=0,mw2=0;
    m.rounds.forEach(r=>{
      let rw1=0,rw2=0;
      (r.games||[]).forEach(g=>{
        const s1=parseInt(g.s1)||0,s2=parseInt(g.s2)||0;
        if(!s1&&!s2) return;
        t1.gw+=s1>s2?1:0; t1.gl+=s1<s2?1:0;
        t2.gw+=s2>s1?1:0; t2.gl+=s2<s1?1:0;
        t1.ps+=s1; t1.pa+=s2; t2.ps+=s2; t2.pa+=s1;
        rw1+=s1>s2?1:0; rw2+=s2>s1?1:0;
      });
      if(rw1>rw2) mw1++; else if(rw2>rw1) mw2++;
    });
    t1.rds++; t2.rds++;
    if(mw1>mw2){t1.w++;t2.l++;} else if(mw2>mw1){t2.w++;t1.l++;} else{t1.t++;t2.t++;}
  });
  return Object.values(tm).map(t=>({...t,pts:t.w*2+t.t,diff:t.ps-t.pa}))
    .sort((a,b)=>b.pts-a.pts||b.gw-a.gw||b.ps-a.ps||b.diff-a.diff);
}

function computePlayerStats(matches, teamMap) {
  const pm={};
  function gP(name,teamId){
    if(!name) return null;
    const k=name.trim().toLowerCase();
    if(!pm[k]){const t=teamMap[teamId]||{};pm[k]={name:name.trim(),teamName:t.name||'',teamColor:t.color||'#2D7BA8',gp:0,gw:0,gl:0,ps:0,pa:0,diff:0};}
    return pm[k];
  }
  matches.forEach(m=>{
    if(!m.team1_id||!m.team2_id) return;
    (m.rounds||[]).forEach(r=>(r.games||[]).forEach(g=>{
      const s1=parseInt(g.s1)||0,s2=parseInt(g.s2)||0;
      if(!s1&&!s2) return;
      const p1=gP(g.p1,m.team1_id), p2=gP(g.p2,m.team2_id);
      if(p1){p1.gp++;p1.ps+=s1;p1.pa+=s2;p1.gw+=s1>s2?1:0;p1.gl+=s1<s2?1:0;p1.diff+=s1-s2;}
      if(p2){p2.gp++;p2.ps+=s2;p2.pa+=s1;p2.gw+=s2>s1?1:0;p2.gl+=s2<s1?1:0;p2.diff+=s2-s1;}
    }));
  });
  return Object.values(pm);
}

// ── NEWS ─────────────────────────────────────────────
async function getNews(seasonId) {
  const key=`news_${seasonId||'all'}`;
  const cached=cGet(key);if(cached)return cached;
  const f=seasonId?`season_id=eq.${seasonId}&order=created_at.desc`:`order=created_at.desc`;
  const rows=await sb.select('news','*',f);
  const data=rows||[];cSet(key,data);return data;
}

// ── PHOTOS ────────────────────────────────────────────
async function getPhotos(seasonId, divisionId) {
  let f=`order=created_at.desc`;
  if(seasonId) f=`season_id=eq.${seasonId}&${f}`;
  const rows=await sb.select('photos','*',f);
  return rows||[];
}

// ── PLAYERS ───────────────────────────────────────────
async function getPlayerByAuthId(authUserId) {
  const rows=await sb.select('players','*',`auth_user_id=eq.${authUserId}`);
  return rows&&rows[0]||null;
}

async function getPlayerByEmail(email) {
  const rows=await sb.select('players','*',`email=eq.${encodeURIComponent(email)}`);
  return rows&&rows[0]||null;
}

async function upsertPlayer(data) {
  return sb.upsert('players', data);
}

// ── RENDER: Division selector (public pages) ──────────
async function renderDivisionSelector(containerId, onSelect) {
  const season = await getActiveSeason();
  if (!season) { document.getElementById(containerId).innerHTML='<p style="color:var(--text-light)">No active season.</p>'; return; }
  const divisions = await getDivisions(season.id);
  const groups = groupDivisions(divisions);

  const container = document.getElementById(containerId);
  if (!container) return;

  const ageOrder  = ['Open','40+','Junior'];
  const genderOrder = ['Ladies','Mens','Mixed','Junior'];

  container.innerHTML = `
    <div class="division-selector">
      <div class="season-banner">
        <span class="season-badge">${season.name}</span>
        <span class="season-year">${season.year}</span>
      </div>
      <div class="div-filter-row">
        ${ageOrder.map(ag=>`
          <div class="div-group" data-group="${ag}">
            <div class="div-group-label">${ag==='Open'?'&#127934;':ag==='40+'?'&#129312;':'&#128118;'} ${ag}</div>
            <div class="div-pills">
              ${divisions.filter(d=>{
                const a=d.age_group==='40plus'?'40+':d.age_group==='junior'?'Junior':'Open';
                return a===ag;
              }).map(d=>`
                <button class="div-pill" data-div-id="${d.id}" onclick="selectDivision(${d.id},'${d.name}')">
                  ${d.name}
                </button>`).join('')}
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

function selectDivision(divId, divName) {
  document.querySelectorAll('.div-pill').forEach(b=>b.classList.remove('active'));
  const btn = document.querySelector(`.div-pill[data-div-id="${divId}"]`);
  if (btn) btn.classList.add('active');
  localStorage.setItem('sbpl_selected_div', divId);
  localStorage.setItem('sbpl_selected_div_name', divName);
  // Dispatch event so page can react
  window.dispatchEvent(new CustomEvent('divisionSelected', {detail:{divId,divName}}));
}

// ── RENDER: Standings table ───────────────────────────
async function renderStandingsForDivision(divisionId, tbodyId) {
  const [teams, matches] = await Promise.all([
    getTeamsByDivision(divisionId),
    getMatchesByDivision(divisionId)
  ]);
  const rows = computeStandings(teams, matches);
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  if (!rows.length) { tbody.innerHTML=`<tr><td colspan="11" style="text-align:center;padding:2rem;color:var(--text-light)">No teams yet in this division.</td></tr>`; return; }
  tbody.innerHTML = rows.map((r,i)=>{
    const trophy=i===0?'🥇':i===1?'🥈':i===2?'🥉':'';
    return `<tr class="${i<4?'top-row':''}">
      <td>${i+1}</td>
      <td style="font-weight:500">${trophy?`<span style="margin-right:.3rem">${trophy}</span>`:''}${r.team}</td>
      <td>${r.rds}</td><td>${r.w}</td><td>${r.l}</td><td>${r.t}</td>
      <td class="pts">${r.pts}</td><td>${r.gw}</td><td>${r.ps}</td><td>${r.pa}</td>
      <td style="color:${r.diff>0?'var(--kelp)':r.diff<0?'var(--sunset-deep)':'var(--text-light)'};font-weight:500">${r.diff>0?'+':''}${r.diff}</td>
    </tr>`;
  }).join('');
}

// ── RENDER: Teams grid ────────────────────────────────
async function renderTeamsForDivision(divisionId, gridId) {
  const [teams, matches] = await Promise.all([
    getTeamsByDivision(divisionId),
    getMatchesByDivision(divisionId)
  ]);
  const standings = computeStandings(teams, matches);
  const grid = document.getElementById(gridId);
  if (!grid) return;
  if (!teams.length) { grid.innerHTML='<div class="empty-state"><p>No teams yet in this division.</p></div>'; return; }

  // Load rosters for all teams in parallel
  const rosterResults = await Promise.all(
    teams.map(t => sb.select('team_players','*,players(first,last,dupr_id)',`team_id=eq.${t.id}&status=eq.active`))
  );

  const colors=['#e8f4f8','#f0e8d8','#f8e8e4','#e8f0e8','#e8e4f8','#f4ece4'];
  grid.innerHTML = teams.map((t, idx) => {
    const sr = standings.find(s=>s.teamId===t.id)||{w:0,l:0,t:0,pts:0};
    const initials = (t.name||'').split(' ').map(w=>w[0]).join('').slice(0,3).toUpperCase();
    const roster = rosterResults[idx] || [];
    const captain = roster.find(tp=>tp.role==='captain');
    const capName = captain&&captain.players ? `${captain.players.first} ${captain.players.last}` : '';
    const rosterHTML = roster.length ? `
      <div class="team-roster">
        <h4>Roster</h4>
        <div class="team-roster-list">
          ${roster.map(tp=>{
            const p = tp.players||{};
            const init = ((p.first||'')[0]||'').toUpperCase()+((p.last||'')[0]||'').toUpperCase();
            return `<div class="roster-player">
              <div class="roster-avatar" style="background:${t.color||'#2D7BA8'}">${init}</div>
              <span>${p.first} ${p.last}${tp.role==='captain'?'<span class="captain-badge">C</span>':''}</span>
            </div>`;
          }).join('')}
        </div>
      </div>` : '';
    return `<div class="team-card">
      <div class="team-card-header" style="background:${colors[idx%colors.length]}">
        <div class="team-logo" style="background:${t.color||'#2D7BA8'}">${initials}</div>
        <div class="team-name-block">
          <h3>${t.name}</h3>
          ${capName?`<p>Captain: ${capName}</p>`:''}
        </div>
      </div>
      <div class="team-stats-row">
        <div class="team-stat"><div class="team-stat-val">${sr.w}</div><div class="team-stat-lbl">Wins</div></div>
        <div class="team-stat"><div class="team-stat-val">${sr.l}</div><div class="team-stat-lbl">Losses</div></div>
        <div class="team-stat"><div class="team-stat-val">${sr.t}</div><div class="team-stat-lbl">Ties</div></div>
        <div class="team-stat"><div class="team-stat-val" style="color:var(--sunset-deep)">${sr.pts}</div><div class="team-stat-lbl">Pts</div></div>
      </div>
      ${rosterHTML}
    </div>`;
  }).join('');
}

// ── RENDER: Schedule for division ────────────────────
async function renderScheduleForDivision(divisionId, containerId) {
  const [sched, matches, teams] = await Promise.all([
    getScheduleByDivision(divisionId),
    getMatchesByDivision(divisionId),
    getTeamsByDivision(divisionId)
  ]);
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!sched.length) { container.innerHTML='<p style="color:var(--text-light)">Schedule not yet posted for this division.</p>'; return; }

  const teamMap={};teams.forEach(t=>teamMap[t.id]=t);

  container.innerHTML = sched.map(w=>{
    const match = matches.find(m=>m.week_index===w.week_index);
    const hasScore = match&&match.rounds&&match.rounds.length;
    const t1 = match&&teamMap[match.team1_id];
    const t2 = match&&teamMap[match.team2_id];
    return `<div class="week-accordion" id="wacc-${w.id}">
      <button class="week-acc-btn${hasScore?'':' open'}" onclick="toggleWeekAcc(${w.id})">
        <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;flex:1">
          <span class="week-pill">${w.label||'Week '+w.week_index}</span>
          <span style="font-size:.85rem;color:var(--text-mid)">${w.match_date?new Date(w.match_date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}):'TBD'} &middot; ${w.time_slot||'TBD'}</span>
          <span class="${hasScore?'ms-final':'ms-upcoming'}">${hasScore?'&#10003; Final':'&#8594; Upcoming'}</span>
        </div>
        <span class="week-acc-chevron">&#9660;</span>
      </button>
      <div class="week-acc-body" style="display:block">
        <div class="week-match-grid">${buildMatchCardNew(w, match, t1, t2)}</div>
      </div>
    </div>`;
  }).join('');
}

function toggleWeekAcc(id) {
  const btn  = document.querySelector(`#wacc-${id} .week-acc-btn`);
  const body = document.querySelector(`#wacc-${id} .week-acc-body`);
  const chev = document.querySelector(`#wacc-${id} .week-acc-chevron`);
  const open = body.style.display!=='none';
  body.style.display = open?'none':'block';
  chev.innerHTML = open?'&#9660;':'&#9650;';
  btn.classList.toggle('open',!open);
}

function buildMatchCardNew(week, match, t1, t2) {
  if (!match||!t1||!t2) {
    return `<div class="match-card-aloha" style="grid-column:1/-1;text-align:center;padding:1.5rem;color:var(--text-light)">
      <p>Matchups not yet assigned for this week.</p>
    </div>`;
  }
  const i1=t1.name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,3);
  const i2=t2.name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,3);
  const ta=(t,init)=>`<div style="text-align:center">
    <div style="width:48px;height:48px;border-radius:50%;background:${t.color||'#2D7BA8'};display:flex;align-items:center;justify-content:center;font-family:'Bebas Neue',sans-serif;font-size:1rem;color:white;margin:0 auto .4rem">${init}</div>
    <div style="font-weight:600;font-size:.85rem">${t.name}</div>
  </div>`;
  if (!match.rounds||!match.rounds.length) {
    return `<div class="match-card-aloha">
      <div style="font-size:.7rem;color:var(--text-light);margin-bottom:.75rem">&#128205; ${week.location}</div>
      <div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:.5rem">
        ${ta(t1,i1)}
        <div style="font-size:.75rem;font-weight:700;color:var(--text-light);background:var(--sand);padding:.3rem .6rem;border-radius:6px">VS</div>
        ${ta(t2,i2)}
      </div>
    </div>`;
  }
  let ms1=0,ms2=0;
  const rHTML=match.rounds.map(r=>{
    const games=r.games||[];
    const rw1=games.filter(g=>(g.s1||0)>(g.s2||0)).length;
    const rw2=games.filter(g=>(g.s2||0)>(g.s1||0)).length;
    if(rw1>rw2)ms1++;else if(rw2>rw1)ms2++;
    return `<div class="round-row">
      <div class="round-label">${r.type}</div>
      ${games.filter(g=>g.s1||g.s2).map(g=>{
        const s1=parseInt(g.s1)||0,s2=parseInt(g.s2)||0,w1=s1>s2,w2=s2>s1;
        return `<div class="game-row">
          <span class="game-player left">${g.p1||''}</span>
          <span class="game-score ${w1?'win':w2?'loss':''}">${s1}</span>
          <span style="font-size:.6rem;color:var(--text-light)">-</span>
          <span class="game-score ${w2?'win':w1?'loss':''}">${s2}</span>
          <span class="game-player right">${g.p2||''}</span>
        </div>`;
      }).join('')}
      <div class="round-summary">Games ${rw1}–${rw2}</div>
    </div>`;
  }).join('');
  const winner=ms1>ms2?t1.name:ms2>ms1?t2.name:'Tie';
  const c1=ms1>ms2?'var(--kelp)':ms2>ms1?'var(--sunset-deep)':'var(--text-mid)';
  const c2=ms2>ms1?'var(--kelp)':ms1>ms2?'var(--sunset-deep)':'var(--text-mid)';
  return `<div class="match-card-aloha has-score">
    <div style="font-size:.7rem;color:var(--text-light);margin-bottom:.75rem">&#128205; ${week.location}</div>
    <div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:.5rem;margin-bottom:.85rem">
      ${ta(t1,i1)}
      <div style="font-size:.75rem;font-weight:700;color:var(--text-light);background:var(--sand);padding:.3rem .6rem;border-radius:6px">VS</div>
      ${ta(t2,i2)}
    </div>
    ${rHTML}
    <div class="match-final-row">
      <div style="text-align:center"><div class="match-score-big" style="color:${c1}">${ms1}</div><div style="font-size:.62rem;color:var(--text-light)">rounds</div></div>
      <div style="font-size:.75rem;font-weight:600;color:var(--text-mid)">${ms1===ms2?'&#129309; Tie':'&#127942; '+winner}</div>
      <div style="text-align:center"><div class="match-score-big" style="color:${c2}">${ms2}</div><div style="font-size:.62rem;color:var(--text-light)">rounds</div></div>
    </div>
  </div>`;
}

// ── RENDER: News ──────────────────────────────────────
async function renderNews(seasonId, gridId='news-grid') {
  const news = await getNews(seasonId);
  const grid = document.getElementById(gridId);
  if (!grid) return;
  if (!news.length) { grid.innerHTML='<p style="color:var(--text-light)">No news yet.</p>'; return; }
  grid.innerHTML = news.map(n=>`<div class="news-card">
    <div class="news-card-img">${n.emoji||'📰'}</div>
    <div class="news-card-body">
      <div class="news-card-tag">${n.tag}</div>
      <h3>${n.title}</h3><p>${n.body}</p>
      <div class="news-card-date">${n.date_label||''}</div>
    </div>
  </div>`).join('');
}

// ── Admin: render admin data ──────────────────────────
async function initAdminPage() {
  await Promise.all([
    renderAdminDashboard(),
    renderAdminSeasons(),
    renderAdminDivisions(),
    renderAdminTeamsPanel(),
    renderAdminPlayers(),
    renderAdminNews(),
    renderAdminSchedulePanel(),
  ]);
}

function showAdminPanel(id) {
  document.querySelectorAll('.admin-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.admin-nav-item').forEach(i=>i.classList.remove('active'));
  const panel = document.getElementById('apanel-'+id);
  const navItem = document.querySelector(`[data-apanel="${id}"]`);
  if (panel) panel.classList.add('active');
  if (navItem) navItem.classList.add('active');
}

async function renderAdminDashboard() {
  const seasons  = await getSeasons();
  const season   = seasons.find(s=>s.status==='active')||seasons[0];
  const allPlayers = season ? await sb.select('team_players','id',`season_id=eq.${season.id}`) : [];
  const allTeams   = season ? await sb.select('teams','id,status',`season_id=eq.${season.id}`) : [];
  const pendingTeams = (allTeams||[]).filter(t=>t.status==='pending');

  const el = document.getElementById('admin-stats-row');
  if (el) el.innerHTML = `
    <div class="admin-stat"><div class="admin-stat-val">${seasons.length}</div><div class="admin-stat-lbl">Seasons</div></div>
    <div class="admin-stat"><div class="admin-stat-val" style="color:#4ade80">${(allTeams||[]).filter(t=>t.status==='active').length}</div><div class="admin-stat-lbl">Active Teams</div></div>
    <div class="admin-stat"><div class="admin-stat-val" style="color:var(--sunset-gold)">${pendingTeams.length}</div><div class="admin-stat-lbl">Pending Teams</div></div>
    <div class="admin-stat"><div class="admin-stat-val">${(allPlayers||[]).length}</div><div class="admin-stat-lbl">Registered Players</div></div>`;
}

async function renderAdminSeasons() {
  const seasons = await getSeasons();
  const list = document.getElementById('seasons-list');
  if (!list) return;
  list.innerHTML = seasons.map(s=>`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:1rem 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <div>
        <div style="font-weight:600;color:#e2e8f0">${s.name} <span style="font-size:.8rem;color:#64748b">${s.year}</span></div>
        <div style="font-size:.78rem;color:#64748b;margin-top:.2rem">${s.start_date||'TBD'} &rarr; ${s.end_date||'TBD'} &middot; ${s.description||''}</div>
      </div>
      <div style="display:flex;gap:.5rem;align-items:center">
        <span class="admin-badge ${s.status==='active'?'badge-green':s.status==='upcoming'?'badge-amber':'badge-blue'}">${s.status}</span>
        ${s.status!=='active'?`<button class="btn btn-sm" style="background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.3);color:#4ade80" onclick="setSeasonStatus(${s.id},'active')">Set Active</button>`:''}
        ${s.status==='active'?`<button class="btn btn-sm" style="background:rgba(59,130,246,.15);border:1px solid rgba(59,130,246,.3);color:#60a5fa" onclick="setSeasonStatus(${s.id},'archived')">Archive</button>`:''}
      </div>
    </div>`).join('') || '<p style="color:#475569">No seasons yet.</p>';
}

async function setSeasonStatus(id, status) {
  await sb.update('seasons',{status},`id=eq.${id}`);
  C['seasons']=null; // bust cache
  await renderAdminSeasons();
  toast(`Season ${status}!`);
}

async function addSeason() {
  const name  = document.getElementById('s-name').value.trim();
  const year  = parseInt(document.getElementById('s-year').value)||new Date().getFullYear();
  const start = document.getElementById('s-start').value;
  const end   = document.getElementById('s-end').value;
  const desc  = document.getElementById('s-desc').value.trim();
  if (!name) return toast('Season name is required.',true);
  const result = await sb.insert('seasons',{name,year,start_date:start||null,end_date:end||null,description:desc,status:'upcoming'});
  if (!result) return toast('Failed to create season.',true);
  delete C['seasons'];
  ['s-name','s-start','s-end','s-desc'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  document.getElementById('s-year').value=new Date().getFullYear();
  await renderAdminSeasons();
  toast('Season created! ✓');
}

async function renderAdminDivisions() {
  const seasons = await getSeasons();
  // Populate season select
  const sel = document.getElementById('div-season-select');
  if (sel) {
    sel.innerHTML = seasons.map(s=>`<option value="${s.id}">${s.name} (${s.year})</option>`).join('');
  }
  // Load divisions for first season
  if (seasons.length) await loadDivisionsForSeason(seasons[0].id);
}

async function loadDivisionsForSeason(seasonId) {
  const divs = await getDivisions(seasonId);
  const tbody = document.getElementById('divisions-tbody');
  if (!tbody) return;
  tbody.innerHTML = divs.map(d=>`<tr>
    <td style="font-weight:500;color:#e2e8f0">${d.name}</td>
    <td>${d.gender}</td><td>${d.age_group}</td><td>${d.skill_level}</td>
    <td><span class="admin-badge ${d.status==='active'?'badge-green':d.status==='completed'?'badge-blue':'badge-amber'}">${d.status}</span></td>
    <td>${d.min_teams}–${d.max_teams}</td>
    <td style="display:flex;gap:.4rem;flex-wrap:wrap">
      <button class="btn btn-sm" style="background:rgba(245,166,35,.15);color:var(--sunset-gold);border:1px solid rgba(245,166,35,.3)" onclick="editDivision(${d.id})">&#9998; Edit</button>
      <button class="btn btn-danger btn-sm" onclick="deleteDivision(${d.id})">Remove</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="7" style="color:#475569;text-align:center">No divisions yet for this season.</td></tr>';
}

async function addDivision() {
  const seasonId  = document.getElementById('div-season-select').value;
  const gender    = document.getElementById('d-gender').value;
  const ageGroup  = document.getElementById('d-age').value;
  const skill     = document.getElementById('d-skill').value;
  if (!seasonId||!gender||!skill) return toast('Please fill all required fields.',true);
  const agePrefix = ageGroup==='40plus'?'40+ ':ageGroup==='junior'?'Junior ':'';
  const gLabel    = {ladies:'Ladies',mens:'Mens',mixed:'Mixed',junior:'Junior'}[gender]||gender;
  const name      = `${agePrefix}${gLabel} ${skill}`;
  const roundTypes= gender==='ladies'?'["WD"]':gender==='mens'?'["MD"]':'["WD","MD","MXD"]';
  const result = await sb.insert('divisions',{
    season_id:parseInt(seasonId), name, gender, age_group:ageGroup,
    skill_level:skill, round_types:JSON.parse(roundTypes),
    min_teams:parseInt(document.getElementById('d-min').value)||4,
    max_teams:parseInt(document.getElementById('d-max').value)||12,
    status:'upcoming'
  });
  if (!result) return toast('Failed — division may already exist.',true);
  delete C[`divs_${seasonId}`];
  await loadDivisionsForSeason(seasonId);
  toast('Division added! ✓');
}

async function deleteDivision(id) {
  if (!confirm('Remove this division? All teams and matches in it will be deleted.')) return;
  await sb.delete('divisions',`id=eq.${id}`);
  const sel=document.getElementById('div-season-select');
  if(sel){delete C[`divs_${sel.value}`];await loadDivisionsForSeason(sel.value);}
  toast('Division removed.');
}

async function renderAdminTeamsPanel() {
  const seasons = await getSeasons();
  const sel = document.getElementById('team-season-select');
  if (sel) sel.innerHTML = seasons.map(s=>`<option value="${s.id}">${s.name} (${s.year})</option>`).join('');
  if (seasons.length) await loadTeamsForSeason(seasons[0].id);
}

async function loadTeamsForSeason(seasonId) {
  const divs = await getDivisions(seasonId);
  const allTeams = await sb.select('teams','*,divisions(name),players(first,last)',`season_id=eq.${seasonId}&order=created_at.desc`);
  const tbody = document.getElementById('admin-teams-body');
  if (!tbody) return;
  tbody.innerHTML = (allTeams||[]).map(t=>`<tr>
    <td style="font-weight:500;color:#e2e8f0">${t.name}</td>
    <td style="color:#64748b">${t.divisions?t.divisions.name:'—'}</td>
    <td>${t.players?t.players.first+' '+t.players.last:'—'}</td>
    <td><span class="admin-badge ${t.status==='active'?'badge-green':t.status==='pending'?'badge-amber':'badge-blue'}">${t.status}</span></td>
    <td style="display:flex;gap:.4rem;flex-wrap:wrap">
      <button class="btn btn-sm" style="background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.3);color:#4ade80" onclick="approveTeam(${t.id})">&#10003; Approve</button>
      <button class="btn btn-sm" style="background:rgba(59,130,246,.15);border:1px solid rgba(59,130,246,.3);color:#60a5fa" onclick="moveTeamModal(${t.id})">Move Division</button>
      <button class="btn btn-danger btn-sm" onclick="removeTeam(${t.id})">Remove</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="5" style="color:#475569;text-align:center;padding:2rem">No teams yet.</td></tr>';
}

async function approveTeam(id) {
  await sb.update('teams',{status:'active'},`id=eq.${id}`);
  const sel=document.getElementById('team-season-select');
  if(sel) await loadTeamsForSeason(sel.value);
  toast('Team approved! ✓');
}

async function removeTeam(id) {
  if (!confirm('Remove this team?')) return;
  await sb.delete('teams',`id=eq.${id}`);
  const sel=document.getElementById('team-season-select');
  if(sel) await loadTeamsForSeason(sel.value);
  toast('Team removed.');
}

async function moveTeamModal(teamId) {
  const seasons = await getSeasons();
  const season  = seasons.find(s=>s.status==='active')||seasons[0];
  const divs    = season ? await getDivisions(season.id) : [];
  const divSel  = divs.map(d=>`<option value="${d.id}">${d.name}</option>`).join('');
  const newDiv  = prompt(`Move team to division:\n${divs.map((d,i)=>`${i+1}. ${d.name}`).join('\n')}\n\nEnter division name exactly:`);
  if (!newDiv) return;
  const match = divs.find(d=>d.name.toLowerCase()===newDiv.toLowerCase());
  if (!match) return toast('Division not found.',true);
  await sb.update('teams',{division_id:match.id},`id=eq.${teamId}`);
  const sel=document.getElementById('team-season-select');
  if(sel) await loadTeamsForSeason(sel.value);
  toast(`Team moved to ${match.name}! ✓`);
}

async function renderAdminPlayers() {
  const rows = await sb.select('players','*','order=last.asc');
  const tbody = document.getElementById('admin-all-players');
  if (!tbody) return;
  tbody.innerHTML = (rows||[]).map(p=>`<tr>
    <td style="font-weight:500;color:#e2e8f0">${p.first} ${p.last}</td>
    <td style="color:#60a5fa">${p.email}</td>
    <td>${p.phone||'—'}</td>
    <td>${p.dob||'—'}</td>
    <td>${p.dupr_id||'—'}</td>
  </tr>`).join('') || '<tr><td colspan="5" style="color:#475569;text-align:center;padding:2rem">No players yet.</td></tr>';
}

async function renderAdminNews() {
  const seasons = await getSeasons();
  const sel = document.getElementById('news-season-select');
  if (sel) sel.innerHTML = `<option value="">All Seasons</option>`+seasons.map(s=>`<option value="${s.id}">${s.name}</option>`).join('');
  const rows = await getNews();
  const list = document.getElementById('news-items-list');
  if (!list) return;
  list.innerHTML = rows.map(n=>`
    <div style="display:flex;align-items:flex-start;gap:1rem;padding:1rem 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <div style="font-size:1.5rem">${n.emoji||'📰'}</div>
      <div style="flex:1">
        <div style="font-weight:500;color:#e2e8f0">${n.title}</div>
        <div style="font-size:.75rem;color:#64748b;margin-top:.2rem">${n.tag} &middot; ${n.date_label||''}</div>
        <div style="font-size:.8rem;color:#94a3b8;margin-top:.3rem">${(n.body||'').slice(0,80)}...</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteNews(${n.id})">Delete</button>
    </div>`).join('') || '<p style="color:#475569;font-size:.85rem">No news yet.</p>';
}

async function addNewsItem() {
  const title = document.getElementById('news-title').value.trim();
  const body  = document.getElementById('news-body').value.trim();
  if (!title||!body) return toast('Title and body required.',true);
  const seasonId = document.getElementById('news-season-select')?.value||null;
  await sb.insert('news',{
    title, body,
    season_id:  seasonId?parseInt(seasonId):null,
    tag:        document.getElementById('news-tag').value,
    emoji:      document.getElementById('news-emoji').value||'📰',
    date_label: document.getElementById('news-date').value||new Date().toLocaleDateString('en-US',{month:'long',year:'numeric'})
  });
  delete C['news_all']; delete C[`news_${seasonId}`];
  ['news-title','news-body','news-date'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  await renderAdminNews(); toast('News added! ✓');
}

async function deleteNews(id) {
  await sb.delete('news',`id=eq.${id}`);
  Object.keys(C).filter(k=>k.startsWith('news')).forEach(k=>delete C[k]);
  await renderAdminNews(); toast('Deleted.');
}

async function renderAdminSchedulePanel() {
  const seasons = await getSeasons();
  const sel = document.getElementById('sched-season-select');
  if (sel) sel.innerHTML = seasons.map(s=>`<option value="${s.id}">${s.name}</option>`).join('');
  const divSel = document.getElementById('sched-div-select');
  if (divSel && seasons.length) await loadDivSelectForSched(seasons[0].id);
}

async function loadDivSelectForSched(seasonId) {
  const divs = await getDivisions(seasonId);
  const sel  = document.getElementById('sched-div-select');
  if (sel) sel.innerHTML = `<option value="">— Select division —</option>`+divs.map(d=>`<option value="${d.id}">${d.name}</option>`).join('');
}

async function exportCSV() {
  const rows = await sb.select('players','*','order=last.asc');
  if (!rows||!rows.length) return toast('No players to export.',true);
  const h=['First','Last','Email','Phone','DOB','DUPR ID'];
  const csv=[h.join(','),...rows.map(p=>[p.first,p.last,p.email,p.phone||'',p.dob||'',p.dupr_id||''].map(v=>`"${String(v).replace(/"/g,'""')}"`))].join('\n');
  const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);a.download=`sbpl-players-${new Date().toISOString().slice(0,10)}.csv`;a.click();
  toast('CSV downloaded! ✓');
}

// ── Contact form ─────────────────────────────────────
function submitContact() {
  const n=document.getElementById('c-name')?.value.trim();
  const e=document.getElementById('c-email')?.value.trim();
  const m=document.getElementById('c-message')?.value.trim();
  if(!n||!e||!m) return toast('Please fill in all fields.',true);
  ['c-name','c-email','c-message'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  toast("Message sent! We'll respond within 24 hours. 🌊");
}

// ── Init ─────────────────────────────────────────────
markActiveNav();
