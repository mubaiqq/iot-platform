var PAGE_MAP={
  welcome:'/admin/pages/welcome.html',
  device_list:'/admin/pages/device_list.html',
  device_add:'/admin/pages/device_add.html',
  device_group:'/admin/pages/device_group.html',
  realtime:'/admin/pages/realtime.html',
  history:'/admin/pages/history.html',
  alarm:'/admin/pages/alarm.html',
  user_manage:'/admin/pages/user_manage.html',
  user_add:'/admin/pages/user_add.html',
  role:'/admin/pages/role.html',
  site:'/admin/pages/site.html',
  register_settings:'/admin/pages/register_settings.html',
  llm_settings:'/admin/pages/llm_settings.html',
  weather_settings:'/admin/pages/weather_settings.html',
  account:'/admin/pages/account.html',
  mqtt:'/admin/pages/mqtt.html',
  database:'/admin/pages/database.html',
  firmware:'/admin/pages/firmware_manage.html',
  about:'/admin/pages/about.html'
};
var tabs=[],activeTab=null,contextTabId=null;

/* ========== Toast ========== */
function showToast(msg,type){
  var t=document.getElementById('toast');
  t.className='toast '+(type||'info');
  t.innerHTML='<i class="fas fa-'+(type==='success'?'check-circle':type==='error'?'exclamation-circle':'info-circle')+'"></i>'+msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer=setTimeout(function(){t.classList.remove('show')},2200);
}

function showConfirm(title,msg,opts){
  opts=opts||{};
  var doc=top.document;
  var overlay=doc.getElementById('confirmOverlay');
  var iconEl=doc.getElementById('confirmIcon');
  var okBtn=doc.getElementById('confirmOk');
  doc.getElementById('confirmTitle').textContent=title;
  doc.getElementById('confirmMsg').textContent=msg;
  okBtn.textContent=opts.okText||'确定';
  doc.getElementById('confirmCancel').textContent=opts.cancelText||'取消';
  iconEl.className='confirm-icon'+(opts.type?' type-'+opts.type:'');
  iconEl.innerHTML='<i class="fas fa-'+(opts.icon||(opts.type==='danger'?'exclamation-triangle':'question'))+'"></i>';
  if(opts.type==='danger'){okBtn.style.background='#dc2626';okBtn.style.boxShadow='0 2px 8px rgba(220,38,38,.25)'}
  else{okBtn.style.background='';okBtn.style.boxShadow=''}
  overlay.classList.add('show');
  return new Promise(function(resolve){
    function close(r){
      overlay.classList.remove('show');
      setTimeout(function(){okBtn.onclick=null;doc.getElementById('confirmCancel').onclick=null;resolve(r)},300);
    }
    okBtn.onclick=function(){close(true)};
    doc.getElementById('confirmCancel').onclick=function(){close(false)};
    overlay.onclick=function(e){if(e.target===overlay)close(false)};
  });
}

/* ========== Sidebar ========== */
var sidebar=document.getElementById('sidebar'),overlay=document.getElementById('sidebarOverlay');
document.getElementById('btnToggle').addEventListener('click',function(){
  if(window.innerWidth<=768){sidebar.classList.toggle('open');overlay.classList.toggle('show')}
  else{sidebar.style.display=sidebar.style.display==='none'?'':'none'}
});
overlay.addEventListener('click',function(){sidebar.classList.remove('open');overlay.classList.remove('show')});
function toggleGroup(el){el.closest('.nav-group').classList.toggle('collapsed')}

/* Nav — use event delegation with click */
document.getElementById('sidebarNav').addEventListener('click',function(e){
  var item=e.target.closest('.nav-item');if(!item)return;
  if(item.classList.contains('is-disabled')||item.dataset.disabled==='1'){
    e.preventDefault();
    if(typeof showToast==='function')showToast((item.dataset.title||'该功能')+'正在开发中','info');
    return;
  }
  var page=item.dataset.page,title=item.dataset.title,icon=item.dataset.icon;if(!page)return;
  document.querySelectorAll('.nav-item').forEach(function(n){n.classList.remove('active')});
  item.classList.add('active');
  openTab(page,title,icon,item.dataset.closable!=='0');
  if(window.innerWidth<=768){sidebar.classList.remove('open');overlay.classList.remove('show')}
});

/* ========== Tab Click — event delegation on tab-list ========== */
document.getElementById('tabList').addEventListener('click',function(e){
  var closeBtn=e.target.closest('.tab-close');
  if(closeBtn){
    var tabEl=closeBtn.closest('.tab-item');
    if(tabEl)closeTab(tabEl.dataset.id);
    return;
  }
  var tabEl=e.target.closest('.tab-item');
  if(tabEl)activateTab(tabEl.dataset.id);
});

/* ========== Tab Management ========== */
function openTab(id,title,icon,closable,url){
  if(closable===undefined)closable=true;
  if(!tabs.find(function(t){return t.id===id})){
    tabs.push({id:id,title:title,icon:icon,closable:closable,url:url||null});
    renderTabs();createFrame(id);
    var el=document.querySelector('.tab-item[data-id="'+id+'"]');
    if(el){el.classList.add('tab-new');setTimeout(function(){el.classList.remove('tab-new')},500)}
    scrollTabIntoView(id);
  }
  activateTab(id);
}
function activateTab(id){
  activeTab=id;
  document.querySelectorAll('.tab-item').forEach(function(t){
    var isActive=t.dataset.id===id;
    t.classList.toggle('active',isActive);
    if(isActive){t.classList.add('tab-jelly');setTimeout(function(){t.classList.remove('tab-jelly')},500)}
  });
  document.querySelectorAll('.content-frame').forEach(function(f){f.classList.toggle('active',f.dataset.id===id)});
  document.querySelectorAll('.nav-item').forEach(function(n){n.classList.toggle('active',n.dataset.page===id)});
  scrollTabIntoView(id);
  try{localStorage.setItem('admin_active_tab',id)}catch(e){}
}
function closeTab(id){
  var tab=tabs.find(function(t){return t.id===id});
  if(!tab||!tab.closable)return;
  var idx=tabs.findIndex(function(t){return t.id===id});
  tabs.splice(idx,1);
  var f=document.querySelector('.content-frame[data-id="'+id+'"]');if(f)f.remove();
  if(activeTab===id){
    if(tabs.length>0)activateTab(tabs[Math.min(idx,tabs.length-1)].id);
    else activeTab=null;
  }
  renderTabs();saveTabs();
}
function closeOtherTabs(){
  var keep=activeTab;
  tabs=tabs.filter(function(t){return t.id===keep||!t.closable});
  document.querySelectorAll('.content-frame').forEach(function(f){
    if(f.dataset.id!==keep&&tabs.findIndex(function(t){return t.id===f.dataset.id})===-1)f.remove();
  });
  renderTabs();saveTabs();
}
function closeAllTabs(){
  tabs=tabs.filter(function(t){return !t.closable});
  document.querySelectorAll('.content-frame').forEach(function(f){
    if(tabs.findIndex(function(t){return t.id===f.dataset.id})===-1)f.remove();
  });
  if(tabs.length>0)activateTab(tabs[0].id);else activeTab=null;
  renderTabs();saveTabs();
}
function createFrame(id){
  var tab=tabs.find(function(t){return t.id===id});
  var url=(tab&&tab.url)||PAGE_MAP[id];if(!url)return;
  var iframe=document.createElement('iframe');
  iframe.className='content-frame';iframe.dataset.id=id;iframe.src=url;
  document.getElementById('contentArea').appendChild(iframe);
}
function renderTabs(){
  var html='';
  tabs.forEach(function(t){
    var cls=t.id===activeTab?'tab-item active':'tab-item';
    var closeBtn=t.closable?'<span class="tab-close"><i class="fas fa-xmark"></i></span>':'';
    html+='<div class="'+cls+'" data-id="'+t.id+'">'
      +'<i class="fas '+t.icon+'" style="font-size:10px"></i> '
      +'<span>'+t.title+'</span>'+closeBtn+'</div>';
  });
  document.getElementById('tabList').innerHTML=html;
}
function saveTabs(){}
function scrollTabIntoView(id){
  var el=document.querySelector('.tab-item[data-id="'+id+'"]');
  if(el)setTimeout(function(){el.scrollIntoView({behavior:'smooth',inline:'end',block:'nearest'})},50);
}

/* ========== Context Menu ========== */
var ctxMenu=document.getElementById('tabContextMenu');
var tabDropBtn=document.getElementById('tabDropBtn');
var tabDropMenu=document.getElementById('tabDropMenu');
if(tabDropBtn)tabDropBtn.addEventListener('click',function(e){
  e.stopPropagation();tabDropMenu.classList.toggle('show');
});
function showTabContext(e,id){e.preventDefault();contextTabId=id;ctxMenu.style.display='block';ctxMenu.style.left=e.clientX+'px';ctxMenu.style.top=e.clientY+'px'}
document.getElementById('tabList').addEventListener('contextmenu',function(e){
  var tabEl=e.target.closest('.tab-item');
  if(tabEl)showTabContext(e,tabEl.dataset.id);
});
document.addEventListener('click',function(){ctxMenu.style.display='none'});

/* ========== Header ========== */
function refreshCurrent(){
  if(!activeTab)return;
  var f=document.querySelector('.content-frame[data-id="'+activeTab+'"]');
  if(f)f.src=f.src;
  showToast('已刷新当前页面','success');
}
function clearCache(){
  try{localStorage.clear();sessionStorage.clear()}catch(e){}
  if('caches' in window){
    caches.keys().then(function(names){
      return Promise.all(names.map(function(name){return caches.delete(name)}));
    }).then(function(){showToast('缓存已清理','success');setTimeout(hardReload,800)});
  } else {
    showToast('缓存已清理','success');
    setTimeout(hardReload,800);
  }
}
function hardReload(){
  var base=window.location.href.split('?')[0];
  window.location.replace(base+'?_t='+Date.now());
}
function closeCurrentTab(){
  if(activeTab)closeTab(activeTab);
  closeDropMenu();
}
function closeDropMenu(){
  document.getElementById('tabDropMenu').classList.remove('show');
}
function toggleFullscreen(){if(!document.fullscreenElement)document.documentElement.requestFullscreen();else document.exitFullscreen()}
function toggleUserMenu(e){
  if(e)e.stopPropagation();
  document.getElementById('userDropdown').classList.toggle('show');
}
document.addEventListener('click',function(e){
  if(!e.target.closest('.user-menu'))document.getElementById('userDropdown').classList.remove('show');
  if(!e.target.closest('.tab-dropdown-wrap'))document.getElementById('tabDropMenu').classList.remove('show');
});

/* ========== Modal ========== */
var modalOverlay=document.getElementById('modalOverlay');
var modalBox=document.getElementById('modalBox');
var modalTitle=document.getElementById('modalTitle');
var modalIframe=document.getElementById('modalIframe');
var modalClose=document.getElementById('modalClose');
var modalLoading=document.getElementById('modalLoading');

function showLoading(){modalLoading.classList.remove('hidden')}
function hideLoading(){modalLoading.classList.add('hidden')}

modalIframe.addEventListener('load',hideLoading);

function openModal(url,title,w,h){
  modalTitle.textContent=title||'';
  showLoading();
  modalIframe.src=url;
  if(w)modalBox.style.width=w;
  else modalBox.style.width='';
  if(h)modalBox.style.height=h;
  else modalBox.style.height='';
  modalOverlay.classList.add('show');
}
function openModalPost(url,title,params,w,h){
  modalTitle.textContent=title||'';
  showLoading();
  modalOverlay.classList.add('show');
  if(w)modalBox.style.width=w;
  else modalBox.style.width='';
  if(h)modalBox.style.height=h;
  else modalBox.style.height='';
  var doc=modalIframe.contentDocument||modalIframe.contentWindow.document;
  doc.open();doc.write('<html><head></head><body><form method="POST" action="'+url+'" id="f">');
  if(params)Object.keys(params).forEach(function(k){doc.write('<input type="hidden" name="'+k+'" value="'+params[k].replace(/"/g,'&quot;')+'">');});
  doc.write('</form><script>document.getElementById("f").submit();<\/script></body></html>');doc.close();
}
var modalFullscreen=document.getElementById('modalFullscreen');
function toggleModalFullscreen(){
  modalOverlay.classList.toggle('tab-fullscreen');
  var isFs=modalOverlay.classList.contains('tab-fullscreen');
  modalFullscreen.querySelector('i').className=isFs?'fas fa-compress':'fas fa-expand';
}
modalFullscreen.addEventListener('click',toggleModalFullscreen);
function closeModal(){
  modalOverlay.classList.remove('tab-fullscreen');
  modalFullscreen.querySelector('i').className='fas fa-expand';
  if(window.matchMedia('(max-width:768px)').matches){
    modalOverlay.classList.add('closing');
    setTimeout(function(){
      modalOverlay.classList.remove('show','closing');
      modalIframe.src='about:blank';
      modalLoading.classList.remove('hidden');
    },220);
  }else{
    modalOverlay.classList.remove('show');
    modalIframe.src='about:blank';
    modalLoading.classList.remove('hidden');
  }
}
modalClose.addEventListener('click',closeModal);
modalOverlay.addEventListener('click',function(e){if(e.target===modalOverlay)closeModal()});

/* ========== Theme ========== */
var THEME_DEFAULT={mode:'light',headerColor:'default',sidebarColor:'default'};
var curTheme;
function loadTheme(){
  try{var s=localStorage.getItem('admin_theme');curTheme=s?JSON.parse(s):Object.assign({},THEME_DEFAULT)}catch(e){curTheme=Object.assign({},THEME_DEFAULT)}
  applyTheme();
}
function saveTheme(){try{localStorage.setItem('admin_theme',JSON.stringify(curTheme))}catch(e){}}
function applyTheme(){
  var el=document.documentElement;
  el.setAttribute('data-theme',curTheme.mode==='dark'?'dark':'');
  el.setAttribute('data-header-color',curTheme.headerColor);
  el.setAttribute('data-sidebar-color',curTheme.sidebarColor);
  document.querySelectorAll('.theme-mode-btn').forEach(function(b){b.classList.toggle('active',b.dataset.mode===curTheme.mode)});
  document.querySelectorAll('.color-btn[data-header-color]').forEach(function(b){b.classList.toggle('active',b.dataset.headerColor===curTheme.headerColor)});
  document.querySelectorAll('.color-btn[data-sidebar-color]').forEach(function(b){b.classList.toggle('active',b.dataset.sidebarColor===curTheme.sidebarColor)});
}
function setThemeMode(m){curTheme.mode=m;saveTheme();applyTheme()}
function setHeaderColor(c){curTheme.headerColor=c;saveTheme();applyTheme()}
function setSidebarColor(c){curTheme.sidebarColor=c;saveTheme();applyTheme()}
function resetTheme(){curTheme=Object.assign({},THEME_DEFAULT);saveTheme();applyTheme();showToast('已恢复默认主题','success')}
function toggleThemePanel(){
  document.getElementById('themePanel').classList.toggle('show');
  document.getElementById('themeOverlay').classList.toggle('show');
}
loadTheme();

/* ========== Init (deferred — caller must define PAGE_MAP first) ========== */
function initDefaultTab(){
  try{localStorage.removeItem('admin_tabs');localStorage.removeItem('admin_active_tab')}catch(e){}
  openTab('welcome','首页','fa-house',false);
}
