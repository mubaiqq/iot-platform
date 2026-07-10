     1|var PAGE_MAP={
     2|  welcome:'hom.html',ymlist:'ymlist.html',add_domain:'add_domain.html',ymcl:'ymcl.html',
     3|  user_list:'user_list.html',tjyh:'tjyh.html',ql:'ql.html',
     4|  order_list:'order_list.html',
     5|  site:'site.html',account:'account.html',payment_settings:'payment_settings.html',template:'template.html',
     6|  about:'about.html'
     7|};
     8|var tabs=[],activeTab=null,contextTabId=null;
     9|
    10|/* ========== Toast ========== */
    11|function showToast(msg,type){
    12|  var t=document.getElementById('toast');
    13|  t.className='toast '+(type||'info');
    14|  t.innerHTML='<i class="fas fa-'+(type==='success'?'check-circle':type==='error'?'exclamation-circle':'info-circle')+'"></i>'+msg;
    15|  t.classList.add('show');
    16|  clearTimeout(t._timer);
    17|  t._timer=setTimeout(function(){t.classList.remove('show')},2200);
    18|}
    19|
    20|function showConfirm(title,msg,opts){
    21|  opts=opts||{};
    22|  var doc=top.document;
    23|  var overlay=doc.getElementById('confirmOverlay');
    24|  var iconEl=doc.getElementById('confirmIcon');
    25|  var okBtn=doc.getElementById('confirmOk');
    26|  doc.getElementById('confirmTitle').textContent=title;
    27|  doc.getElementById('confirmMsg').textContent=msg;
    28|  okBtn.textContent=opts.okText||'确定';
    29|  doc.getElementById('confirmCancel').textContent=opts.cancelText||'取消';
    30|  iconEl.className='confirm-icon'+(opts.type?' type-'+opts.type:'');
    31|  iconEl.innerHTML='<i class="fas fa-'+(opts.icon||(opts.type==='danger'?'exclamation-triangle':'question'))+'"></i>';
    32|  if(opts.type==='danger'){okBtn.style.background='#dc2626';okBtn.style.boxShadow='0 2px 8px rgba(220,38,38,.25)'}
    33|  else{okBtn.style.background='';okBtn.style.boxShadow=''}
    34|  overlay.classList.add('show');
    35|  return new Promise(function(resolve){
    36|    function close(r){
    37|      overlay.classList.remove('show');
    38|      setTimeout(function(){okBtn.onclick=null;doc.getElementById('confirmCancel').onclick=null;resolve(r)},300);
    39|    }
    40|    okBtn.onclick=function(){close(true)};
    41|    doc.getElementById('confirmCancel').onclick=function(){close(false)};
    42|    overlay.onclick=function(e){if(e.target===overlay)close(false)};
    43|  });
    44|}
    45|
    46|/* ========== Sidebar ========== */
    47|var sidebar=document.getElementById('sidebar'),overlay=document.getElementById('sidebarOverlay');
    48|document.getElementById('btnToggle').addEventListener('click',function(){
    49|  if(window.innerWidth<=768){sidebar.classList.toggle('open');overlay.classList.toggle('show')}
    50|  else{sidebar.style.display=sidebar.style.display==='none'?'':'none'}
    51|});
    52|overlay.addEventListener('click',function(){sidebar.classList.remove('open');overlay.classList.remove('show')});
    53|function toggleGroup(el){el.closest('.nav-group').classList.toggle('collapsed')}
    54|
    55|/* Nav — use event delegation with click */
    56|document.getElementById('sidebarNav').addEventListener('click',function(e){
    57|  var item=e.target.closest('.nav-item');if(!item)return;
    58|  var page=item.dataset.page,title=item.dataset.title,icon=item.dataset.icon;if(!page)return;
    59|  document.querySelectorAll('.nav-item').forEach(function(n){n.classList.remove('active')});
    60|  item.classList.add('active');
    61|  openTab(page,title,icon,item.dataset.closable!=='0');
    62|  if(window.innerWidth<=768){sidebar.classList.remove('open');overlay.classList.remove('show')}
    63|});
    64|
    65|/* ========== Tab Click — event delegation on tab-list ========== */
    66|document.getElementById('tabList').addEventListener('click',function(e){
    67|  var closeBtn=e.target.closest('.tab-close');
    68|  if(closeBtn){
    69|    var tabEl=closeBtn.closest('.tab-item');
    70|    if(tabEl)closeTab(tabEl.dataset.id);
    71|    return;
    72|  }
    73|  var tabEl=e.target.closest('.tab-item');
    74|  if(tabEl)activateTab(tabEl.dataset.id);
    75|});
    76|
    77|/* ========== Tab Management ========== */
    78|function openTab(id,title,icon,closable,url){
    79|  if(closable===undefined)closable=true;
    80|  if(!tabs.find(function(t){return t.id===id})){
    81|    tabs.push({id:id,title:title,icon:icon,closable:closable,url:url||null});
    82|    renderTabs();createFrame(id);
    83|    var el=document.querySelector('.tab-item[data-id="'+id+'"]');
    84|    if(el){el.classList.add('tab-new');setTimeout(function(){el.classList.remove('tab-new')},500)}
    85|    scrollTabIntoView(id);
    86|  }
    87|  activateTab(id);
    88|}
    89|function activateTab(id){
    90|  activeTab=id;
    91|  document.querySelectorAll('.tab-item').forEach(function(t){
    92|    var isActive=t.dataset.id===id;
    93|    t.classList.toggle('active',isActive);
    94|    if(isActive){t.classList.add('tab-jelly');setTimeout(function(){t.classList.remove('tab-jelly')},500)}
    95|  });
    96|  document.querySelectorAll('.content-frame').forEach(function(f){f.classList.toggle('active',f.dataset.id===id)});
    97|  document.querySelectorAll('.nav-item').forEach(function(n){n.classList.toggle('active',n.dataset.page===id)});
    98|  scrollTabIntoView(id);
    99|  try{localStorage.setItem('admin_active_tab',id)}catch(e){}
   100|}
   101|function closeTab(id){
   102|  var tab=tabs.find(function(t){return t.id===id});
   103|  if(!tab||!tab.closable)return;
   104|  var idx=tabs.findIndex(function(t){return t.id===id});
   105|  tabs.splice(idx,1);
   106|  var f=document.querySelector('.content-frame[data-id="'+id+'"]');if(f)f.remove();
   107|  if(activeTab===id){
   108|    if(tabs.length>0)activateTab(tabs[Math.min(idx,tabs.length-1)].id);
   109|    else activeTab=null;
   110|  }
   111|  renderTabs();saveTabs();
   112|}
   113|function closeOtherTabs(){
   114|  var keep=activeTab;
   115|  tabs=tabs.filter(function(t){return t.id===keep||!t.closable});
   116|  document.querySelectorAll('.content-frame').forEach(function(f){
   117|    if(f.dataset.id!==keep&&tabs.findIndex(function(t){return t.id===f.dataset.id})===-1)f.remove();
   118|  });
   119|  renderTabs();saveTabs();
   120|}
   121|function closeAllTabs(){
   122|  tabs=tabs.filter(function(t){return !t.closable});
   123|  document.querySelectorAll('.content-frame').forEach(function(f){
   124|    if(tabs.findIndex(function(t){return t.id===f.dataset.id})===-1)f.remove();
   125|  });
   126|  if(tabs.length>0)activateTab(tabs[0].id);else activeTab=null;
   127|  renderTabs();saveTabs();
   128|}
   129|function createFrame(id){
   130|  var tab=tabs.find(function(t){return t.id===id});
   131|  var url=(tab&&tab.url)||PAGE_MAP[id];if(!url)return;
   132|  var iframe=document.createElement('iframe');
   133|  iframe.className='content-frame';iframe.dataset.id=id;iframe.src=url;
   134|  document.getElementById('contentArea').appendChild(iframe);
   135|}
   136|function renderTabs(){
   137|  var html='';
   138|  tabs.forEach(function(t){
   139|    var cls=t.id===activeTab?'tab-item active':'tab-item';
   140|    var closeBtn=t.closable?'<span class="tab-close"><i class="fas fa-xmark"></i></span>':'';
   141|    html+='<div class="'+cls+'" data-id="'+t.id+'">'
   142|      +'<i class="fas '+t.icon+'" style="font-size:10px"></i> '
   143|      +'<span>'+t.title+'</span>'+closeBtn+'</div>';
   144|  });
   145|  document.getElementById('tabList').innerHTML=html;
   146|}
   147|function saveTabs(){}
   148|function scrollTabIntoView(id){
   149|  var el=document.querySelector('.tab-item[data-id="'+id+'"]');
   150|  if(el)setTimeout(function(){el.scrollIntoView({behavior:'smooth',inline:'end',block:'nearest'})},50);
   151|}
   152|
   153|/* ========== Context Menu ========== */
   154|var ctxMenu=document.getElementById('tabContextMenu');
   155|var tabDropBtn=document.getElementById('tabDropBtn');
   156|var tabDropMenu=document.getElementById('tabDropMenu');
   157|if(tabDropBtn)tabDropBtn.addEventListener('click',function(e){
   158|  e.stopPropagation();tabDropMenu.classList.toggle('show');
   159|});
   160|function showTabContext(e,id){e.preventDefault();contextTabId=id;ctxMenu.style.display='block';ctxMenu.style.left=e.clientX+'px';ctxMenu.style.top=e.clientY+'px'}
   161|document.getElementById('tabList').addEventListener('contextmenu',function(e){
   162|  var tabEl=e.target.closest('.tab-item');
   163|  if(tabEl)showTabContext(e,tabEl.dataset.id);
   164|});
   165|document.addEventListener('click',function(){ctxMenu.style.display='none'});
   166|
   167|/* ========== Header ========== */
   168|function refreshCurrent(){
   169|  if(!activeTab)return;
   170|  var f=document.querySelector('.content-frame[data-id="'+activeTab+'"]');
   171|  if(f)f.src=f.src;
   172|  showToast('已刷新当前页面','success');
   173|}
   174|function clearCache(){
   175|  try{localStorage.clear();sessionStorage.clear()}catch(e){}
   176|
   177|  // 清除浏览器 Cache API 缓存
   178|  if('caches' in window){
   179|    caches.keys().then(function(names){
   180|      return Promise.all(names.map(function(name){return caches.delete(name)}));
   181|    }).then(function(){showToast('缓存已清理','success');setTimeout(hardReload,800)});
   182|  } else {
   183|    showToast('缓存已清理','success');
   184|    setTimeout(hardReload,800);
   185|  }
   186|}
   187|function hardReload(){
   188|  // 去掉已有的缓存破坏参数，加上新的时间戳，强制浏览器重新请求
   189|  var base=window.location.href.split('?')[0];
   190|  window.location.replace(base+'?_t='+Date.now());
   191|}
   192|function closeCurrentTab(){
   193|  if(activeTab)closeTab(activeTab);
   194|  closeDropMenu();
   195|}
   196|function closeDropMenu(){
   197|  document.getElementById('tabDropMenu').classList.remove('show');
   198|}
   199|function toggleFullscreen(){if(!document.fullscreenElement)document.documentElement.requestFullscreen();else document.exitFullscreen()}
   200|function toggleUserMenu(e){
   201|  if(e)e.stopPropagation();
   202|  document.getElementById('userDropdown').classList.toggle('show');
   203|}
   204|document.addEventListener('click',function(e){
   205|  if(!e.target.closest('.user-menu'))document.getElementById('userDropdown').classList.remove('show');
   206|  if(!e.target.closest('.tab-dropdown-wrap'))document.getElementById('tabDropMenu').classList.remove('show');
   207|});
   208|
   209|/* ========== Modal ========== */
   210|var modalOverlay=document.getElementById('modalOverlay');
   211|var modalBox=document.getElementById('modalBox');
   212|var modalTitle=document.getElementById('modalTitle');
   213|var modalIframe=document.getElementById('modalIframe');
   214|var modalClose=document.getElementById('modalClose');
   215|var modalLoading=document.getElementById('modalLoading');
   216|
   217|function showLoading(){modalLoading.classList.remove('hidden')}
   218|function hideLoading(){modalLoading.classList.add('hidden')}
   219|
   220|modalIframe.addEventListener('load',hideLoading);
   221|
   222|function openModal(url,title,w,h){
   223|  modalTitle.textContent=title||'';
   224|  showLoading();
   225|  modalIframe.src=url;
   226|  if(w)modalBox.style.width=w;
   227|  else modalBox.style.width='';
   228|  if(h)modalBox.style.height=h;
   229|  else modalBox.style.height='';
   230|  modalOverlay.classList.add('show');
   231|}
   232|function openModalPost(url,title,params,w,h){
   233|  modalTitle.textContent=title||'';
   234|  showLoading();
   235|  modalOverlay.classList.add('show');
   236|  if(w)modalBox.style.width=w;
   237|  else modalBox.style.width='';
   238|  if(h)modalBox.style.height=h;
   239|  else modalBox.style.height='';
   240|  var doc=modalIframe.contentDocument||modalIframe.contentWindow.document;
   241|  doc.open();doc.write('<html><head></head><body><form method="POST" action="'+url+'" id="f">');
   242|  if(params)Object.keys(params).forEach(function(k){doc.write('<input type="hidden" name="'+k+'" value="'+params[k].replace(/"/g,'&quot;')+'">');});
   243|  doc.write('</form><script>document.getElementById("f").submit();<\/script></body></html>');doc.close();
   244|}
   245|var modalFullscreen=document.getElementById('modalFullscreen');
   246|function toggleModalFullscreen(){
   247|  modalOverlay.classList.toggle('tab-fullscreen');
   248|  var isFs=modalOverlay.classList.contains('tab-fullscreen');
   249|  modalFullscreen.querySelector('i').className=isFs?'fas fa-compress':'fas fa-expand';
   250|}
   251|modalFullscreen.addEventListener('click',toggleModalFullscreen);
   252|function closeModal(){
   253|  modalOverlay.classList.remove('tab-fullscreen');
   254|  modalFullscreen.querySelector('i').className='fas fa-expand';
   255|  if(window.matchMedia('(max-width:768px)').matches){
   256|    modalOverlay.classList.add('closing');
   257|    setTimeout(function(){
   258|      modalOverlay.classList.remove('show','closing');
   259|      modalIframe.src='about:blank';
   260|      modalLoading.classList.remove('hidden');
   261|    },220);
   262|  }else{
   263|    modalOverlay.classList.remove('show');
   264|    modalIframe.src='about:blank';
   265|    modalLoading.classList.remove('hidden');
   266|  }
   267|}
   268|modalClose.addEventListener('click',closeModal);
   269|modalOverlay.addEventListener('click',function(e){if(e.target===modalOverlay)closeModal()});
   270|
   271|/* ========== Theme ========== */
   272|var THEME_DEFAULT={mode:'light',headerColor:'default',sidebarColor:'default'};
   273|var curTheme;
   274|function loadTheme(){
   275|  try{var s=localStorage.getItem('admin_theme');curTheme=s?JSON.parse(s):Object.assign({},THEME_DEFAULT)}catch(e){curTheme=Object.assign({},THEME_DEFAULT)}
   276|  applyTheme();
   277|}
   278|function saveTheme(){try{localStorage.setItem('admin_theme',JSON.stringify(curTheme))}catch(e){}}
   279|function applyTheme(){
   280|  var el=document.documentElement;
   281|  el.setAttribute('data-theme',curTheme.mode==='dark'?'dark':'');
   282|  el.setAttribute('data-header-color',curTheme.headerColor);
   283|  el.setAttribute('data-sidebar-color',curTheme.sidebarColor);
   284|  document.querySelectorAll('.theme-mode-btn').forEach(function(b){b.classList.toggle('active',b.dataset.mode===curTheme.mode)});
   285|  document.querySelectorAll('.color-btn[data-header-color]').forEach(function(b){b.classList.toggle('active',b.dataset.headerColor===curTheme.headerColor)});
   286|  document.querySelectorAll('.color-btn[data-sidebar-color]').forEach(function(b){b.classList.toggle('active',b.dataset.sidebarColor===curTheme.sidebarColor)});
   287|}
   288|function setThemeMode(m){curTheme.mode=m;saveTheme();applyTheme()}
   289|function setHeaderColor(c){curTheme.headerColor=c;saveTheme();applyTheme()}
   290|function setSidebarColor(c){curTheme.sidebarColor=c;saveTheme();applyTheme()}
   291|function resetTheme(){curTheme=Object.assign({},THEME_DEFAULT);saveTheme();applyTheme();showToast('已恢复默认主题','success')}
   292|function toggleThemePanel(){
   293|  document.getElementById('themePanel').classList.toggle('show');
   294|  document.getElementById('themeOverlay').classList.toggle('show');
   295|}
   296|loadTheme();
   297|
   298|/* ========== Init ========== */
   299|(function(){
   300|  try{localStorage.removeItem('admin_tabs');localStorage.removeItem('admin_active_tab')}catch(e){}
   301|  openTab('welcome','首页','fa-house',false);
   302|})();
   303|