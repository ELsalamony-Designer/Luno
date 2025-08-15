
const API = window.location.origin;
const tokenKey = 'luno_token';

function saveToken(t){ localStorage.setItem(tokenKey, t); }
function getToken(){ return localStorage.getItem(tokenKey); }
function authHeader(){ const t=getToken(); return t? {'Authorization':'Bearer '+t}:{}; }

async function register(){
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  const res = await fetch('/api/auth/register', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username,password})});
  const data = await res.json();
  if(data.token){ saveToken(data.token); location.href='/feed.html'; } else { alert(data.error||'Error'); }
}
async function login(){
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  const res = await fetch('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username,password})});
  const data = await res.json();
  if(data.token){ saveToken(data.token); location.href='/feed.html'; } else { alert(data.error||'Error'); }
}

// Upload
async function submitUpload(){
  const f = document.getElementById('media').files[0];
  if(!f) return alert('Choose a file');
  const fd = new FormData();
  fd.append('media', f);
  fd.append('caption', document.getElementById('caption').value || '');
  const res = await fetch('/api/posts', { method:'POST', headers: authHeader(), body: fd });
  if(res.ok){ location.href='/feed.html'; } else { alert('Upload failed'); }
}

// Feed
async function loadFeed(){
  const feed = document.getElementById('feed'); if(!feed) return;
  const res = await fetch('/api/feed', { headers: authHeader() });
  if(res.status==401){ return location.href='/'; }
  const posts = await res.json();
  feed.innerHTML = '';
  for(const p of posts){
    const card = document.createElement('div');
    card.className = 'bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden';
    const head = document.createElement('div');
    head.className = 'flex items-center gap-3 p-3';
    head.innerHTML = \`
      <img src="\${p.avatar||'/assets/favicon.png'}" class="w-8 h-8 rounded-full bg-gray-700"/>
      <div class="flex-1">
        <div class="font-semibold">@\${p.username}</div>
        <div class="text-xs text-gray-400">\${new Date(p.created_at).toLocaleString()}</div>
      </div>
    \`;
    const media = document.createElement(p.media_type==='video'?'video':'img');
    media.className = 'w-full max-h-[70vh] object-contain bg-black';
    if(p.media_type==='video'){ media.src = p.media_url; media.controls = true; media.playsInline = true; }
    else { media.src = p.media_url; }
    const cap = document.createElement('div');
    cap.className='p-3 text-sm text-gray-200';
    cap.textContent = p.caption || '';
    const actions = document.createElement('div');
    actions.className = 'p-3 flex items-center gap-3';
    const likeBtn = document.createElement('button');
    likeBtn.className = 'px-3 py-2 rounded-xl bg-gray-800 hover:bg-gray-700';
    likeBtn.textContent = (p.liked? '♥ Unlike' : '♡ Like') + ' ('+p.likes+')';
    likeBtn.onclick = async ()=>{
      await fetch('/api/posts/'+p.id+(p.liked?'/unlike':'/like'), {method:'POST', headers: authHeader()});
      loadFeed();
    };
    const commentBox = document.createElement('input');
    commentBox.placeholder='Write a comment';
    commentBox.className='flex-1 p-2 rounded-xl bg-gray-800 border border-gray-700';
    const commentBtn = document.createElement('button');
    commentBtn.className='px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700';
    commentBtn.textContent='Comment';
    commentBtn.onclick = async ()=>{
      const content = commentBox.value.trim();
      if(!content) return;
      await fetch('/api/posts/'+p.id+'/comment', {method:'POST', headers:{...authHeader(),'Content-Type':'application/json'}, body: JSON.stringify({content})});
      commentBox.value=''; loadComments(p.id, commentsWrap);
    };
    actions.append(likeBtn, commentBox, commentBtn);
    const commentsWrap = document.createElement('div');
    commentsWrap.className='p-3 space-y-2 border-t border-gray-800';
    card.append(head, media, cap, actions, commentsWrap);
    feed.append(card);
    loadComments(p.id, commentsWrap);
  }
}

async function loadComments(postId, el){
  const res = await fetch('/api/posts/'+postId+'/comments', { headers: authHeader() });
  const rows = await res.json();
  el.innerHTML = '';
  for(const c of rows){
    const line = document.createElement('div');
    line.className = 'text-sm text-gray-300';
    line.innerHTML = '<span class="font-semibold">@'+c.username+':</span> '+c.content;
    el.append(line);
  }
}

// Profile me
async function loadMe(){
  const meEl = document.getElementById('me'); if(!meEl) return;
  const res = await fetch('/api/users/me', { headers: authHeader() });
  if(res.status==401){ return location.href='/'; }
  const me = await res.json();
  meEl.innerHTML = \`
    <img src="\${me.avatar||'/assets/favicon.png'}" class="w-16 h-16 rounded-full bg-gray-700"/>
    <div class="flex-1">
      <div class="font-semibold text-lg">@\${me.username}</div>
      <div class="text-sm text-gray-400">Followers: \${me.followers} · Following: \${me.following} · Posts: \${me.posts}</div>
    </div>
    <label class="text-sm px-3 py-2 rounded-xl bg-gray-800 cursor-pointer">
      Change avatar
      <input id="avatarInput" type="file" accept="image/*" class="hidden" onchange="uploadAvatar(event)"/>
    </label>
  \`;
}

// Avatar upload
async function uploadAvatar(ev){
  const f = ev.target.files[0];
  if(!f) return;
  const fd = new FormData(); fd.append('avatar', f);
  await fetch('/api/users/avatar', { method:'POST', headers: authHeader(), body: fd });
  loadMe();
}

// Chat
let socket=null;
function initSocket(){
  const el = document.getElementById('dmLog');
  if(!el) return;
  socket = io();
  socket.on('connect', ()=>{
    socket.emit('auth', getToken());
  });
  socket.on('dm', (msg)=>{
    const div = document.createElement('div');
    div.className='p-2 bg-gray-800 rounded-xl';
    const me = parseJwt(getToken())?.id;
    const who = msg.from===me?'You':'Them';
    div.textContent = who+': '+msg.content;
    el.prepend(div);
  });
}
function sendDM(){
  if(!socket) return;
  socket.emit('dm', { to: document.getElementById('dmTo').value.trim(), content: document.getElementById('dmText').value.trim() });
  document.getElementById('dmText').value='';
}
function parseJwt (token) {
  if(!token) return null;
  const base = token.split('.')[1];
  try { return JSON.parse(atob(base)); } catch { return null; }
}

// Auto-init on pages
window.addEventListener('DOMContentLoaded', ()=>{
  loadFeed();
  loadMe();
  initSocket();
});
