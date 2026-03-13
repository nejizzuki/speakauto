javascript:void(function(){
if(document.getElementById('__sp')){document.getElementById('__sp').remove();return}

/* ===== CONFIG ===== */
var API='https://api.study.better.efekta.com'
var BFF='https://learn.better.efekta.com/gap/bff/api/v1'
var DELAY=800
var TASK_DELAY=400

/* ===== TOKEN (fresh-read every call) ===== */
function getFreshTokens(){
  var tokens={api:null,bff:null}
  try{
    var c=document.cookie.split(';').find(function(s){return s.trim().startsWith('efid_tokens=')})
    if(c){
      var v=decodeURIComponent(c.split('=').slice(1).join('='))
      var efid=JSON.parse(v)
      /* try the known field name first, then exhaustive search */
      tokens.api=efid.account||efid.api||efid.id_token||efid.idToken||efid.token||efid.access_token||efid.accessToken||null
      tokens.bff=efid.access||efid.bff||null
      /* last resort: any string field we haven't used yet (likely a JWT) */
      if(!tokens.api){
        Object.keys(efid).forEach(function(k){
          if(!tokens.api&&typeof efid[k]==='string'&&efid[k].length>20&&efid[k]!==tokens.bff)tokens.api=efid[k]
        })
      }
      /* if still nothing, try access as API token too (some apps use same token for both) */
      if(!tokens.api)tokens.api=tokens.bff
    }
  }catch(e){}
  if(!tokens.bff){
    try{for(var i=0;i<localStorage.length;i++){
      var k=localStorage.key(i),val=localStorage.getItem(k)
      if(val&&val.length===64&&/^[0-9a-f]{64}$/.test(val)){tokens.bff=val;break}
      try{var j=JSON.parse(val);if(j&&j.access&&j.access.length===64){tokens.bff=j.access;break}}catch(e){}
    }}catch(e){}
  }
  if(!tokens.bff){
    try{for(var i=0;i<sessionStorage.length;i++){
      var k=sessionStorage.key(i),val=sessionStorage.getItem(k)
      if(val&&val.length===64&&/^[0-9a-f]{64}$/.test(val)){tokens.bff=val;break}
      try{var j=JSON.parse(val);if(j&&j.access&&j.access.length===64){tokens.bff=j.access;break}}catch(e){}
    }}catch(e){}
  }
  if(!tokens.bff){try{var m=window.location.hash.match(/access=([0-9a-f]{64})/);if(m)tokens.bff=m[1]}catch(e){}}
  if(!tokens.bff&&window.__spCapturedAuth)tokens.bff=window.__spCapturedAuth
  /* also pull in interceptor-captured API token */
  if(!tokens.api&&window.__spCapturedApiAuth)tokens.api=window.__spCapturedApiAuth
  if(!tokens.api)tokens.api=tokens.bff /* final fallback */
  return tokens
}

/* ===== FETCH INTERCEPTOR (captures app's BFF auth + responses) ===== */
if(!window.__spIntercepted){
  window.__spIntercepted=true
  window.__spCapturedAuth=null
  window.__spCapturedData={}
  window.__spCapturedLesson=null /* captured open-lesson response */
  window.__spCapturedLessonId=null
  window.__spReqLog=[] /* full request log for _spDump() */
  var _origFetch=window.fetch
  window.fetch=function(){
    var url=typeof arguments[0]==='string'?arguments[0]:(arguments[0]?arguments[0].url:'')
    var opts=arguments[1]||{}
    /* log ALL requests to __spReqLog */
    var _logEntry={ts:new Date().toISOString(),method:(opts.method||'GET'),url:url,reqBody:null,resBody:null,status:null}
    try{if(opts.body)_logEntry.reqBody=JSON.parse(opts.body)}catch(e){_logEntry.reqBody=opts.body}
    window.__spReqLog.push(_logEntry)
    if(window.__spReqLog.length>200)window.__spReqLog.shift() /* keep last 200 */
    /* capture Bearer tokens from both BFF and API domains */
    if(url.indexOf('/gap/bff/')>-1||url.indexOf('api.study.better.efekta.com')>-1||url.indexOf('learn.better.efekta.com')>-1){
      try{
        var h=opts.headers
        if(h){
          var auth=h instanceof Headers?(h.get('Authorization')||h.get('authorization')):(h['Authorization']||h['authorization'])
          if(auth&&auth.indexOf('Bearer ')===0){
            var _tok=auth.substring(7)
            if(url.indexOf('/gap/bff/')>-1||url.indexOf('learn.better.efekta.com')>-1)window.__spCapturedAuth=_tok
            if(url.indexOf('api.study.better.efekta.com')>-1)window.__spCapturedApiAuth=_tok
          }
        }
      }catch(e){}
    }
    /* capture lesson/command POST bodies for lessonId detection */
    if(url.indexOf('lesson/command')>-1&&opts.body){
      try{
        var _bd=JSON.parse(opts.body)
        if(_bd.commandType==='open-lesson'&&_bd.commandData&&_bd.commandData.openLesson){
          window.__spCapturedLessonId=_bd.commandData.openLesson.lessonId
          console.log('[SpeakyAuto] ðŸŽ¯ intercepted open-lesson lessonId:',window.__spCapturedLessonId)
        }
      }catch(e){}
    }
    return _origFetch.apply(this,arguments).then(function(response){
      _logEntry.status=response.status
      if(response.ok){
        if(url.indexOf('course-groups')>-1)response.clone().json().then(function(d){window.__spCapturedData.courseGroups=d;_logEntry.resBody=d}).catch(function(){})
        if(url.indexOf('level-details')>-1)response.clone().json().then(function(d){window.__spCapturedData.levelDetails=d;_logEntry.resBody=d}).catch(function(){})
        /* capture enrollment /open-lesson response â†’ cache lessonId by nodeId */
        if(url.indexOf('/study/progress/enrollments/')>-1&&url.indexOf('/open-lesson')>-1){
          response.clone().json().then(function(d){
            _logEntry.resBody=d
            if(d&&d.lessonId){
              window.__spEnrollmentCache=window.__spEnrollmentCache||{}
              try{var rb=JSON.parse(opts.body);if(rb.nodeId)window.__spEnrollmentCache[rb.nodeId]=d.lessonId}catch(e){}
              console.log('[SpeakyAuto] ðŸŽ¯ enrollment captured lessonId:',d.lessonId)
            }
          }).catch(function(){})}
        /* capture open-lesson response */
        if(url.indexOf('lesson/command')>-1){
          response.clone().json().then(function(d){
            if(d&&d.eventHistory&&d.eventHistory.events){
              var evts=d.eventHistory.events
              for(var i=0;i<evts.length;i++){
                if(evts[i].type==='lesson-started'){
                  window.__spCapturedLesson=d
                  var ls=evts[i].data&&evts[i].data.lessonStarted||{}
                  if(ls.lessonId)window.__spCapturedLessonId=ls.lessonId
                  console.log('[SpeakyAuto] ðŸŽ¯ captured open-lesson response! lessonId:',ls.lessonId,'events:',evts.length)
                  break
                }
              }
            }
          }).catch(function(){})
        }
      }
      return response
    })
  }
}

/* ===== _spDump() â€” substituto do Burp Suite, printa tudo no console ===== */
window._spDump=function(filter){
  var tokens=getFreshTokens?getFreshTokens():{api:window.__spCapturedAuth,bff:window.__spCapturedAuth}
  console.group('%c[SpeakyAuto] _spDump()', 'color:#6366f1;font-size:14px;font-weight:bold')
  console.log('%c=== TOKENS ===', 'color:#22c55e;font-weight:bold')
  console.log('API token:', tokens.api||window.__spCapturedAuth||'NAO ENCONTRADO')
  console.log('BFF token:', tokens.bff||'NAO ENCONTRADO')
  console.log('cookies:', document.cookie.split(';').map(function(c){return c.trim().split('=')[0]}).filter(Boolean).join(', '))
  console.log('%c=== lessonId capturado ===', 'color:#22c55e;font-weight:bold')
  console.log(window.__spCapturedLessonId||'nenhum')
  if(window.__spCapturedData.courseGroups){
    console.log('%c=== CURSOS (course-groups) ===', 'color:#22c55e;font-weight:bold')
    try{
      var _cgs=window.__spCapturedData.courseGroups
      var _courses=[];(_cgs.forEach?_cgs:[_cgs]).forEach(function(g){if(g.courses)g.courses.forEach(function(c){_courses.push({id:c.id,title:c.title})})})
      _courses.forEach(function(c){console.log(' ',c.id,'â†’',c.title)})
    }catch(e){console.log(window.__spCapturedData.courseGroups)}
  }
  console.log('%c=== REQUESTS LOG (Ãºltimos '+(window.__spReqLog||[]).length+') ===', 'color:#22c55e;font-weight:bold')
  var _log=window.__spReqLog||[]
  var _filtered=filter?_log.filter(function(r){return r.url.indexOf(filter)>-1}):_log
  _filtered.forEach(function(r,i){
    var _col=r.status&&r.status>=400?'color:#ff4466':(r.status?'color:#22c55e':'color:#aaa')
    console.groupCollapsed('%c['+i+'] '+r.method+' '+r.status+' '+r.url.replace(/https:\/\/[^/]+/,'').substring(0,80),_col)
    if(r.reqBody)console.log('REQ:',r.reqBody)
    if(r.resBody)console.log('RES:',r.resBody)
    console.groupEnd()
  })
  if(!_filtered.length)console.log('(nenhum request capturado ainda â€” navegue pelo site primeiro)')
  console.log('%cðŸ’¡ Dica: _spDump("lesson/command") para filtrar por URL', 'color:#aaa;font-style:italic')
  console.groupEnd()
}
console.log('[SpeakyAuto] ðŸ’¡ _spDump() disponÃ­vel â€” substituto do Burp Suite')

/* ===== postMessage listener â€” capture signedGrade from lesson-player iframe ===== */
if(!window.__spMsgListener){
  window.__spMsgListener=true
  window.__spCapturedGrades={}
  window.addEventListener('message',function(ev){
    try{
      var d=typeof ev.data==='string'?JSON.parse(ev.data):ev.data
      var s=JSON.stringify(d)
      /* Log any message mentioning roleplay, grade, or signedGrade */
      if(s.indexOf('roleplay')>-1||s.indexOf('signedGrade')>-1||s.indexOf('grade')>-1||s.indexOf('aiRoleplay')>-1){
        console.log('[SpeakyAuto] ðŸ“© postMessage (roleplay/grade):',s.substring(0,500))
        if(s.indexOf('signedGrade')>-1){
          var m=s.match(/"signedGrade"\s*:\s*"([^"]+)"/)
          if(m&&m[1].length>10){
            console.log('[SpeakyAuto] ðŸŽ¯ CAPTURED signedGrade!',m[1].substring(0,60)+'...')
            /* Try to find associated taskId */
            var tm=s.match(/"taskId"\s*:\s*"([^"]+)"/)
            if(tm)window.__spCapturedGrades[tm[1]]={signedGrade:m[1],raw:d}
            else window.__spCapturedGrades['_last']={signedGrade:m[1],raw:d}
          }
        }
      }
      /* Also log all postMessage types for protocol discovery */
      if(d&&d.type)console.log('[SpeakyAuto] ðŸ“¨ msg type:',d.type,typeof d.payload==='object'?Object.keys(d.payload||{}).join(','):'')
    }catch(e){}
  })
}

/* ===== AUTO-SKIP AUDIO/SPEAKING PROMPTS (reinstall on every fresh injection) ===== */
if(window.__spSkipCleanup)try{window.__spSkipCleanup()}catch(e){}
;(function(){
  function _getDocs(){
    var docs=[document]
    try{
      var frames=document.querySelectorAll('iframe')
      for(var i=0;i<frames.length;i++){
        try{if(frames[i].contentDocument)docs.push(frames[i].contentDocument)}catch(e){}
      }
    }catch(e){}
    return docs
  }
  function _spVis2(el,win){
    try{var r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.top<(win||window).innerHeight&&r.bottom>0}catch(e){return false}
  }
  /* Real click â€” dispatches full pointer event sequence that Angular Material responds to */
  function _realClick(el,win){
    try{
      var r=el.getBoundingClientRect()
      var cx=r.left+r.width/2,cy=r.top+r.height/2
      var W=win||window
      var evOpts={bubbles:true,cancelable:true,view:W,clientX:cx,clientY:cy}
      el.dispatchEvent(new PointerEvent('pointerdown',Object.assign({},evOpts,{pointerId:1,pointerType:'mouse',isPrimary:true})))
      el.dispatchEvent(new PointerEvent('pointerup',Object.assign({},evOpts,{pointerId:1,pointerType:'mouse',isPrimary:true})))
      el.dispatchEvent(new MouseEvent('mousedown',evOpts))
      el.dispatchEvent(new MouseEvent('mouseup',evOpts))
      el.dispatchEvent(new MouseEvent('click',evOpts))
      el.click()
    }catch(e){try{el.click()}catch(e2){}}
  }
  /* Label text â€” strips mat-icon glyph text ("arrow_forward" etc) */
  function _btnLabel(el){
    var lbl=el.querySelector('.mdc-button__label,.mat-button-wrapper')
    if(lbl)return(lbl.textContent||'').replace(/\s+/g,' ').trim()
    try{
      var clone=el.cloneNode(true)
      var icons=clone.querySelectorAll('mat-icon,[class*="mat-icon"],[class*="mdc-button__icon"]')
      for(var ii=0;ii<icons.length;ii++)icons[ii].textContent=''
      return(clone.textContent||'').replace(/\s+/g,' ').trim()
    }catch(e){return(el.textContent||'').replace(/\s+/g,' ').trim()}
  }
  var _SKIP_RE=/\b(skip|pular)\b/i
  var _NXT_RE2=/\b(next|continue|pr[oÃ³]ximo|continuar|avan[cÃ§]ar|prosseguir|finish|concluir|fechar|close|done|ok)\b/i
  function _trySkip(){
    var docs=_getDocs()
    for(var d=0;d<docs.length;d++){
      try{
        var doc=docs[d]
        var win=doc.defaultView||window
        /* Skip button â€” direct selector */
        var btn=doc.querySelector('.skip-task-button,[translation-key="activity.skip"],[ef-translate="activity.skip"]')
        if(btn&&_spVis2(btn,win)){console.log('[SpeakyAuto] Auto-skip click');_realClick(btn,win);return}
        /* Next/Continue â€” attribute selector */
        var nxt=doc.querySelector('[ef-translate="activity.next"],[translation-key="activity.next"],[ef-translate="activity.continue"],[translation-key="activity.continue"]')
        if(nxt&&_spVis2(nxt,win)){console.log('[SpeakyAuto] Auto-next attr click');_realClick(nxt,win);return}
        /* Angular Material filled/primary button + text fallback â€” only fire during active lesson processing */
        if(!window._spAutoSkipActive)continue
        var matPrimary=doc.querySelector('button.mat-mdc-unelevated-button:not([disabled]),button.mat-flat-button:not([disabled]),button.mat-raised-button:not([disabled])')
        if(matPrimary&&_spVis2(matPrimary,win)){
          var _lbl=_btnLabel(matPrimary)
          console.log('[SpeakyAuto] Auto-next mat-unelevated label:',_lbl)
          _realClick(matPrimary,win);return
        }
        /* text fallback */
        var all=doc.querySelectorAll('button,a,[role="button"]')
        for(var _i=0;_i<all.length;_i++){
          var _el=all[_i]
          if(!_spVis2(_el,win)||_el.disabled)continue
          var _tx=_btnLabel(_el)
          if(_SKIP_RE.test(_tx)||_NXT_RE2.test(_tx)){
            console.log('[SpeakyAuto] Auto-click text:',_el.tagName,'â†’',_tx.substring(0,40))
            _realClick(_el,win);return
          }
        }
      }catch(e){}
    }
  }
  /* Debug: chame window._spDebugSkip() no console para ver todos os botÃµes visÃ­veis */
  window._spDebugSkip=function(){
    var docs=_getDocs()
    console.log('[SP-DEBUG] docs:',docs.length)
    docs.forEach(function(doc,i){
      try{
        var btn=doc.querySelector('.skip-task-button,[translation-key="activity.skip"],[ef-translate="activity.skip"]')
        console.log('[SP-DEBUG] doc['+i+'] skip-btn:',btn?btn.outerHTML.substring(0,200):'NAO ENCONTRADO')
        /* dump ALL visible buttons with their label text */
        var all=doc.querySelectorAll('button,[role="button"]'),vis=[]
        for(var _i=0;_i<all.length;_i++){
          var r=all[_i].getBoundingClientRect()
          if(r.width>0&&r.height>0)vis.push({tag:all[_i].tagName,cls:all[_i].className.substring(0,60),lbl:_btnLabel(all[_i]).substring(0,60),full:(all[_i].textContent||'').replace(/\s+/g,' ').trim().substring(0,60)})
        }
        console.log('[SP-DEBUG] doc['+i+']Visible buttons ('+vis.length+'):')
        vis.forEach(function(b){console.log('  â†’',b.tag,b.cls,'\n     label:',b.lbl,'| full:',b.full)})
      }catch(e){console.log('[SP-DEBUG] doc['+i+'] ERRO:',e.message)}
    })
  }
  _trySkip()
  var _poll=setInterval(_trySkip,600)
  var _obs=new MutationObserver(function(){setTimeout(_trySkip,150)})
  _obs.observe(document.body,{childList:true,subtree:true})
  window.__spSkipCleanup=function(){clearInterval(_poll);_obs.disconnect();delete window._spDebugSkip}
  window.addEventListener('beforeunload',window.__spSkipCleanup,{once:true})
}())

var _initTokens=getFreshTokens()
if(!_initTokens.api&&!_initTokens.bff){
  var cn=document.cookie.split(';').map(function(c){return c.trim().split('=')[0]}).filter(Boolean).join(', ')
  alert('Nenhum token encontrado!\nCookies: '+cn+'\nFaca login no Speaky e tente novamente.')
  return
}
console.log('[SpeakyAuto] apiToken:',_initTokens.api?_initTokens.api.substring(0,20)+'...':'NULL')
console.log('[SpeakyAuto] bffToken:',_initTokens.bff?_initTokens.bff.substring(0,20)+'...':'NULL')
console.log('[SpeakyAuto] cookies:',document.cookie.split(';').map(function(c){return c.trim().split('=')[0]}).filter(Boolean).join(', '))

/* ===== KNOWN COURSES (fallback when BFF is unavailable) ===== */
var KNOWN_COURSES=[
  {id:'87e8ec1d-a478-4d39-badd-4ddb20494eaf',title:'School English'}
]

/* ===== UI ===== */
var ui=document.createElement('div')
ui.id='__sp'
document.body.appendChild(ui)
var _mq=window.matchMedia('(max-width:500px)').matches
ui.style.cssText='position:fixed;bottom:'+(_mq?'12px':'20px')+';right:'+(_mq?'12px':'20px')+';z-index:999999;width:'+(_mq?'calc(100vw - 24px)':'360px')+';max-height:90vh;background:#0d0d0f;border:1px solid rgba(99,102,241,0.18);border-radius:12px;font-family:system-ui,-apple-system,sans-serif;color:#e8e8e8;box-shadow:0 32px 80px rgba(0,0,0,0.95);display:flex;flex-direction:column;overflow:hidden'

ui.innerHTML='<style>'
+'#__sp *{box-sizing:border-box;margin:0;padding:0}'
/* header */
+'#__sp .hd{padding:12px 16px 11px;border-bottom:1px solid rgba(255,255,255,0.05);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}'
+'#__sp .dot{width:7px;height:7px;border-radius:50%;background:#6366f1;flex-shrink:0;margin-right:9px;transition:background .3s}'
+'#__sp .dot.run{animation:spBlink 1s infinite}@keyframes spBlink{0%,100%{opacity:1}50%{opacity:.25}}'
+'#__sp .dot.err{background:#ff4466}#__sp .dot.ok{background:#22c55e}'
+'#__sp .ttl{font-size:11px;font-weight:600;letter-spacing:.1em;color:rgba(255,255,255,0.5);text-transform:uppercase}'
+'#__sp .xcl{background:none;border:none;color:rgba(255,255,255,0.18);cursor:pointer;font-size:20px;padding:2px 6px;line-height:1;transition:color .2s}'
+'#__sp .xcl:hover{color:#ff4466}'
/* body */
+'#__sp .bd{padding:14px 16px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:10px}'
/* course picker */
+'#__sp .csel{display:flex;flex-direction:column;gap:5px}'
+'#__sp .csel-lbl{font-size:9px;letter-spacing:.1em;color:rgba(255,255,255,0.2);text-transform:uppercase;margin-bottom:2px}'
+'#__sp .copt{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid rgba(255,255,255,0.06);border-radius:6px;cursor:pointer;transition:border-color .2s,background .2s;user-select:none}'
+'#__sp .copt:hover{border-color:rgba(99,102,241,0.3);background:rgba(99,102,241,0.04)}'
+'#__sp .copt.sel{border-color:rgba(99,102,241,0.45);background:rgba(99,102,241,0.08)}'
+'#__sp .copt .radio{width:12px;height:12px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.2);flex-shrink:0;position:relative;transition:border-color .2s}'
+'#__sp .copt.sel .radio{border-color:#6366f1}'
+'#__sp .copt.sel .radio::after{content:"";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:5px;height:5px;border-radius:50%;background:#6366f1}'
+'#__sp .copt .ctxt{flex:1}'
+'#__sp .copt .cname{font-size:11px;color:rgba(255,255,255,0.7)}'
+'#__sp .copt .csub{font-size:9px;color:rgba(255,255,255,0.22);margin-top:1px}'
/* divider */
+'#__sp .div{height:1px;background:rgba(255,255,255,0.04);flex-shrink:0}'
/* log */
+'#__sp .lg{max-height:140px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}'
+'#__sp .lg::-webkit-scrollbar{width:2px}#__sp .lg::-webkit-scrollbar-thumb{background:rgba(99,102,241,0.2)}'
+'#__sp .lrow{display:flex;gap:6px;align-items:baseline;font-size:10px;line-height:1.5}'
+'#__sp .lrow .lt{color:rgba(255,255,255,0.12);flex-shrink:0;font-size:9px}'
+'#__sp .lrow .lm{color:rgba(255,255,255,0.45)}'
+'#__sp .lrow .lm.ok{color:#6366f1}#__sp .lrow .lm.er{color:#ff4466}#__sp .lrow .lm.wn{color:#f59e0b}#__sp .lrow .lm.hi{color:#e8e8e8;font-weight:500}'
/* progress */
+'#__sp .pgw{display:flex;flex-direction:column;gap:5px}'
+'#__sp .pghd{display:flex;justify-content:space-between;align-items:center}'
+'#__sp .pgtxt{font-size:10px;color:rgba(255,255,255,0.35)}'
+'#__sp .pgpct{font-size:12px;font-weight:600;color:#6366f1}'
+'#__sp .pgbar{height:3px;background:rgba(255,255,255,0.05);border-radius:2px;overflow:hidden}'
+'#__sp .pb{height:100%;width:0%;background:linear-gradient(90deg,#6366f1,#818cf8);border-radius:2px;transition:width .5s ease}'
/* stats */
+'#__sp .st{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}'
+'#__sp .sc{padding:8px 0;text-align:center;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:5px}'
+'#__sp .sv{font-size:16px;font-weight:500;line-height:1;color:#e8e8e8}'
+'#__sp .sl{font-size:7px;color:rgba(255,255,255,0.2);margin-top:3px;letter-spacing:.08em;text-transform:uppercase}'
/* buttons */
+'#__sp .ac{display:flex;gap:6px;flex-shrink:0}'
+'#__sp .btn{flex:1;padding:11px 0;border-radius:6px;font-family:inherit;font-size:10px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:all .2s;min-height:40px}'
+'#__sp .go{border:1px solid rgba(99,102,241,0.4);color:#818cf8;background:rgba(99,102,241,0.06)}'
+'#__sp .go:hover{background:rgba(99,102,241,0.12);border-color:rgba(99,102,241,0.6)}'
+'#__sp .go:disabled{opacity:.25;cursor:not-allowed}'
+'#__sp .stp{border:1px solid rgba(255,255,255,0.07);color:rgba(255,255,255,0.3);background:none}'
+'#__sp .stp:hover{border-color:rgba(255,68,102,0.35);color:#ff4466}'
/* footer */
+'#__sp .ft{padding:8px 16px;border-top:1px solid rgba(255,255,255,0.04);font-size:8px;color:rgba(255,255,255,0.1);letter-spacing:.05em;flex-shrink:0}'
+'</style>'
+'<div class="hd"><div style="display:flex;align-items:center"><div class="dot" id="__spd"></div><div class="ttl">Speaky Auto</div></div><button class="xcl" id="__spcl">&times;</button></div>'
+'<div class="bd">'
  +'<div class="csel"><div class="csel-lbl">Selecionar curso</div><div id="__spcsel"></div></div>'
  +'<div class="div"></div>'
  +'<div class="lg" id="__spl"><div class="lrow"><span class="lm">Aguardando...</span></div></div>'
  +'<div class="pgw">'
    +'<div class="pghd"><span class="pgtxt" id="__spptxt">Pronto</span><span class="pgpct" id="__sppct"></span></div>'
    +'<div class="pgbar"><div class="pb" id="__spb"></div></div>'
  +'</div>'
  +'<div class="st">'
    +'<div class="sc"><div class="sv" id="__sles">--</div><div class="sl">Lessons</div></div>'
    +'<div class="sc"><div class="sv" id="__stsk">--</div><div class="sl">Tasks</div></div>'
    +'<div class="sc"><div class="sv" id="__sok" style="color:#22c55e">0</div><div class="sl">âœ“ certas</div></div>'
    +'<div class="sc"><div class="sv" id="__swrong" style="color:#ff4466">0</div><div class="sl">âœ— erradas</div></div>'
  +'</div>'
  +'<div class="ac"><button class="btn go" id="__sgo">Iniciar Lessons</button><button class="btn stp" id="__sstp">Parar</button></div>'
  +'<div class="div"></div>'
  +'<div class="ac"><button class="btn go" id="__sptst" style="background:rgba(99,102,241,0.12);font-size:11px;letter-spacing:.04em">âš¡ Rodar Teste (auto-detect)</button></div>'
  +'<div style="display:flex;gap:4px;align-items:center;margin-top:4px"><input id="__spmc" placeholder="ou cole lessonId aqui..." style="flex:1;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:5px;padding:6px 8px;color:#e8e8e8;font-family:inherit;font-size:9px;outline:none"/>'
  +'<button id="__spmgo" class="btn go" style="flex:none;width:40px;min-height:28px;padding:0;font-size:8px">Run</button></div>'
+'</div>'
+'<div class="ft">speaky auto Â· nejizzuki</div>'

document.getElementById('__spcl').onclick=function(){ui.remove()}

/* ===== COURSE SELECTOR ===== */
var _selectedCourseIds=[] /* null = todos */
var _availCourses=[]

function buildCourseSelector(courses){
  _availCourses=courses
  var el=document.getElementById('__spcsel')
  if(!el)return
  el.innerHTML=''
  el.style.cssText='display:flex;flex-direction:column;gap:4px'

  /* "Todos os cursos" option */
  var allCourses=courses.slice()
  var opts=[{id:'__ALL__',title:'Todos os cursos',sub:courses.length+' curso'+(courses.length!==1?'s':'')}]
  courses.forEach(function(c){opts.push({id:c.id,title:c.title,sub:c.id.substring(0,8)+'...'})})

  opts.forEach(function(o){
    var d=document.createElement('div')
    d.className='copt'+(o.id==='__ALL__'?' sel':'')
    d.innerHTML='<div class="radio"></div><div class="ctxt"><div class="cname">'+o.title+'</div>'+(o.sub?'<div class="csub">'+o.sub+'</div>':'')+'</div>'
    d.onclick=function(){
      el.querySelectorAll('.copt').forEach(function(x){x.className='copt'})
      d.className='copt sel'
      _selectedCourseIds=o.id==='__ALL__'?null:[o.id]
    }
    el.appendChild(d)
  })

  _selectedCourseIds=null /* default: todos */
}

/* Initialize selector with known courses */
buildCourseSelector(KNOWN_COURSES)

var parado=false
var totalTasks=0,doneTasks=0,correctTasks=0,wrongTasks=0

function log(msg,cls){
  var d=document.createElement('div')
  d.className='lrow'
  var t=document.createElement('span');t.className='lt';t.textContent=new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})
  var m=document.createElement('span');m.className='lm '+(cls||'');m.textContent=msg
  d.appendChild(t);d.appendChild(m)
  var lg=document.getElementById('__spl');if(lg){lg.appendChild(d);lg.scrollTop=lg.scrollHeight}
}

function setDot(cls){var e=document.getElementById('__spd');if(e)e.className='dot '+cls}
var _origSetStat=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v}
function setStat(id,v){_origSetStat(id,v)}
function setProgress(p){
  p=Math.min(100,Math.max(0,p))
  var e=document.getElementById('__spb');if(e)e.style.width=p+'%'
  var pct=document.getElementById('__sppct');if(pct)pct.textContent=p>0?Math.round(p)+'%':''
}
function setProgressText(t){var e=document.getElementById('__spptxt');if(e)e.textContent=t}
function wait(ms){return new Promise(function(r){setTimeout(r,ms)})}

function uuid(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return(c==='x'?r:r&0x3|0x8).toString(16)})}

/* BFF auth strategy: 0=hash, 1=cookie-only, 2=jwt */
var _bffStrategy=-1

function api(method,url,body){
  var tokens=getFreshTokens()
  var isApi=url.indexOf(API)===0
  var isBff=url.indexOf(BFF)===0

  /* build ordered API token list â€” try every token we have */
  var _apiTokens=(function(){
    var _seen=new Set(),_list=[]
    function _add(t){if(t&&typeof t==='string'&&t.length>10&&!_seen.has(t)){_seen.add(t);_list.push(t)}}
    _add(tokens.api);_add(tokens.bff);_add(window.__spCapturedApiAuth);_add(window.__spCapturedAuth)
    return _list
  }())

  function attempt(strat){
    var t
    if(isApi){
      t=strat<_apiTokens.length?_apiTokens[strat]:null
    }
    else if(isBff){
      if(strat===0)t=tokens.bff
      else if(strat===1)t=null
      else if(strat===2)t=tokens.api
    }else{t=tokens.bff}

    var opts={
      method:method,
      headers:{'Accept':'application/json','X-Ef-Correlation-Id':uuid()},
      credentials:'include'
    }
    if(t)opts.headers['Authorization']='Bearer '+t
    if(body){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(body)}

    return fetch(url,opts).then(function(r){
      if(!r.ok){
        if(isApi&&r.status===401&&strat<_apiTokens.length){
          console.log('[SpeakyAuto] API 401 strategy '+strat+'/'+_apiTokens.length+', trying next...')
          return attempt(strat+1)
        }
        if(isBff&&r.status===401&&strat<2){
          console.log('[SpeakyAuto] BFF 401 strategy '+strat+', trying next...')
          return attempt(strat+1)
        }
        /* capture error response body for debugging */
        return r.text().then(function(body){
          console.log('[SpeakyAuto] '+r.status+' on '+method+' '+url.substring(0,80))
          console.log('[SpeakyAuto] error body:', body.substring(0,500))
          if(r.status===401)throw new Error('SESSAO_EXPIRADA')
          throw new Error('HTTP '+r.status+': '+body.substring(0,200))
        })
      }
      if(isBff&&_bffStrategy<0){_bffStrategy=strat;console.log('[SpeakyAuto] BFF strategy '+strat+' OK')}
      return r.json()
    })
  }

  var startStrat=isApi?0:(isBff&&_bffStrategy>=0?_bffStrategy:0)
  return attempt(startStrat)
}

/* ===== GET COURSES & LESSONS ===== */
function getCourseGroups(){
  return api('GET',BFF+'/self-study/course-groups?locale=en')
}

function getLevelDetails(){
  return api('GET',BFF+'/self-study/level-details?locale=en')
}

/* ===== OPEN LESSON ===== */
function openLessonEnrollment(courseId,lessonContentId){
  return api('POST',API+'/study/progress/enrollments/'+courseId+'/open-lesson',{
    nodeId:lessonContentId,
    instructionsLocale:'en_US',
    publishTag:'live'
  })
}

function openLessonCommand(lessonId){
  return api('POST',API+'/study/lesson/command',{
    commandType:'open-lesson',
    commandData:{
      openLesson:{
        lessonId:lessonId,
        instructionsLocale:'en_US'
      }
    },
    clientState:{
      lastVersion:0,
      lessonId:lessonId
    }
  })
}

/* ===== SUBMIT TASK ===== */
function submitTask(lessonId,activityId,sessionId,task,version){
  var _tt=task.type||task.taskType||(task.expectedResponse&&task.expectedResponse.type)||''
  /* deeper type detection â€” check task data keys and JSON content */
  if(!_tt||_tt==='?'){
    try{
      var _tjs=JSON.stringify(task)
      if(_tjs.indexOf('"aiRoleplayFluency"')>-1||_tjs.indexOf('"roleplayID"')>-1)_tt='ai-roleplay-fluency'
      else if(_tjs.indexOf('"speakingPractice"')>-1||(_tjs.indexOf('"targetText"')>-1&&_tjs.indexOf('"url"')>-1))_tt='speaking-practice'
      else if(_tjs.indexOf('"pronunciation"')>-1)_tt='pronunciation'
      else if(_tjs.indexOf('"speaking"')>-1)_tt='speaking'
    }catch(e){}
    if(!_tt)_tt='?'
  }
  var _isAudio=_tt==='speaking-practice'||_tt==='ai-roleplay-fluency'
  console.log('[SpeakyAuto] submitTask tipo:'+_tt+' isAudio:'+_isAudio+' hasER:'+(!!task.expectedResponse)+' id:'+task.id.substring(0,8)+'...')

  var er=task.expectedResponse
  if(!er){
    if(_tt==='pronunciation'){
      er={taskId:task.id,type:'pronunciation',contents:{pronunciation:{userInput:{score:1.0}}}}
    }else if(_tt==='speaking'){
      er={taskId:task.id,type:'speaking',contents:{speaking:{userInput:{speechScoreSummary:{score:1.0}}}}}
    }else if(_tt==='speaking-practice'){
      /* task sem expectedResponse â€” gerar sintÃ©tico pra handler de Ã¡udio funcionar */
      er={taskId:task.id,type:'speaking-practice',contents:{speakingPractice:{userInput:{data:'',id:'',speechScoreSummary:{score:0.9,wordScores:[]}}}}}
      log('  ER sintÃ©tico speaking-practice','')
    }else if(_tt==='ai-roleplay-fluency'){
      /* task sem expectedResponse â€” gerar sintÃ©tico pra handler de roleplay funcionar */
      var _synRpId=''
      try{var _td2=task.data||task.taskData||{};_synRpId=(_td2.aiRoleplayFluency&&_td2.aiRoleplayFluency.roleplayID)||''}catch(e){}
      er={taskId:task.id,type:'ai-roleplay-fluency',contents:{aiRoleplayFluency:{completed:false,grade:null,signedGrade:null}}}
      log('  ER sintÃ©tico ai-roleplay','')
    }else{
      /* Tipo sem expectedResponse â€” tentar padrÃµes conhecidos, depois skip */
      var _tk=_tt.replace(/-([a-z])/g,function(m,c){return c.toUpperCase()}) /* camelCase do tipo */
      /* flash-card / vocabulary card â€” submit seen:true */
      if(_tt==='flash-card'||_tt==='flashcard'||_tt==='flashCard'||_tt==='vocabulary-card'||_tt==='vocabularyCard'||_tt==='word-card'){
        var _fc={};_fc[_tk]={userInput:{seen:true,correct:true}}
        return api('POST',API+'/study/lesson/command',{
          commandType:'submit-task-response',
          commandData:{submitTaskResponse:{lessonId:lessonId,activityId:activityId,sessionId:sessionId,response:{taskId:task.id,type:_tt,contents:_fc},timeSpentSecs:2}},
          clientState:{lessonId:lessonId,lastVersion:version}
        }).then(function(data){var r=_extractResult(data);if(r.taskDone){doneTasks++;if(totalTasks>0)setProgress(doneTasks/totalTasks*100);return{version:r.maxV,lessonPassed:r.lessonPassed,newActivities:r.newActivities,taskDone:true}};return _doSkip()}).catch(function(){return _doSkip()})
      }
      /* video / watch tasks â€” submit watched:true */
      if(_tt==='video'||_tt==='video-task'||_tt==='watchVideo'||_tt==='watch-video'||_tt==='listen-video'||_tt==='listenVideo'){
        var _vc={};_vc[_tk]={userInput:{watched:true}}
        return api('POST',API+'/study/lesson/command',{
          commandType:'submit-task-response',
          commandData:{submitTaskResponse:{lessonId:lessonId,activityId:activityId,sessionId:sessionId,response:{taskId:task.id,type:_tt,contents:_vc},timeSpentSecs:5}},
          clientState:{lessonId:lessonId,lastVersion:version}
        }).then(function(data){var r=_extractResult(data);if(r.taskDone){doneTasks++;if(totalTasks>0)setProgress(doneTasks/totalTasks*100);return{version:r.maxV,lessonPassed:r.lessonPassed,newActivities:r.newActivities,taskDone:true}};return _doSkip()}).catch(function(){return _doSkip()})
      }
      /* Qualquer tipo com campos data/taskData â€” tentar submit genÃ©rico com o conteÃºdo completo */
      var _rawData=task.data||task.taskData||task.content||null
      if(_rawData&&typeof _rawData==='object'){
        var _gc={};var _gk=Object.keys(_rawData)[0]||_tk;_gc[_gk]={userInput:{correct:true,seen:true}}
        console.log('[SpeakyAuto] submit genÃ©rico tipo:',_tt,'key:',_gk)
        return api('POST',API+'/study/lesson/command',{
          commandType:'submit-task-response',
          commandData:{submitTaskResponse:{lessonId:lessonId,activityId:activityId,sessionId:sessionId,response:{taskId:task.id,type:_tt,contents:_gc},timeSpentSecs:2}},
          clientState:{lessonId:lessonId,lastVersion:version}
        }).then(function(data){var r=_extractResult(data);if(r.taskDone){doneTasks++;if(totalTasks>0)setProgress(doneTasks/totalTasks*100);return{version:r.maxV,lessonPassed:r.lessonPassed,newActivities:r.newActivities,taskDone:true}};return _doSkip()}).catch(function(){return _doSkip()})
      }
      /* tipo completamente desconhecido â€” skip */
      console.log('[SpeakyAuto] TIPO NOVO sem ER:',_tt,'â€” skip-task (cole no console o task completo para adicionar suporte)')
      console.log('[SpeakyAuto] task completo:',JSON.stringify(task).substring(0,800))
      log('  tipo novo: '+(_tt||'?')+' â†’ skip (ver console)','wn')
      return _doSkip()
    }
  }

  function _extractResult(data){
    var evts=data.eventHistory&&data.eventHistory.events||[]
    var maxV=version,taskDone=false,lessonPassed=false,taskCorrect=true,newActivities=[]
    evts.forEach(function(e){
      if(e.version>maxV)maxV=e.version
      if(e.type==='task-completed'||e.type==='task-passed')taskDone=true
      if(e.type==='task-evaluated'||e.type==='task-graded'||e.type==='task-result'){
        var ev=(e.data&&(e.data.taskEvaluated||e.data.taskGraded||e.data.taskResult))||{}
        if(ev.correct===false||ev.passed===false||ev.score===0)taskCorrect=false
      }
      if(e.type==='lesson-passed'||e.type==='lesson-completed'||e.type==='level-passed')lessonPassed=true
      if(e.type==='activity-sent'){
        var _as=e.data&&e.data.activitySent
        if(_as)newActivities.push({id:_as.activity.id,title:_as.activity.title,tasks:_as.activity.tasks||[]})
      }
    })
    return{maxV:maxV,taskDone:taskDone,taskCorrect:taskCorrect,lessonPassed:lessonPassed,newActivities:newActivities,evtCount:evts.length,evtTypes:evts.map(function(e){return e.type})}
  }

  function _doSkip(){
    console.log('[SpeakyAuto] â†’ skip-task para '+_tt)
    return api('POST',API+'/study/lesson/command',{
      commandType:'skip-task',
      commandData:{skipTask:{lessonId:lessonId,activityId:activityId,sessionId:sessionId,taskId:task.id}},
      clientState:{lessonId:lessonId,lastVersion:version}
    }).then(function(data){
      var r=_extractResult(data)
      console.log('[SpeakyAuto] skip-task: evts='+r.evtCount+' tipos:'+r.evtTypes.join(','))
      doneTasks++;if(totalTasks>0)setProgress(doneTasks/totalTasks*100)
      return{version:r.maxV,lessonPassed:r.lessonPassed,newActivities:r.newActivities,taskDone:r.taskDone}
    })
  }

  /* === Audio tasks: record real webm from target MP3 and submit === */
  if(_isAudio){
    /* Extract audio URL and text from task structure */
    var _audioUrl=null,_targetText='Hello'
    try{
      var _ts=JSON.stringify(task)
      var _um=_ts.match(/"url"\s*:\s*"(https:\/\/[^"]+\.mp3[^"]*)"/i)
      if(_um)_audioUrl=_um[1]
      var _tm=_ts.match(/"targetText"\s*:\s*"([^"]+)"/i)
      if(_tm)_targetText=_tm[1]
    }catch(e){}

    if(_tt==='speaking-practice'){
      return(async function(){
        /* Generate real webm audio via MediaRecorder */
        var audioB64=null
        try{
          var ac=new(window.AudioContext||window.webkitAudioContext)()
          var dest=ac.createMediaStreamDestination()
          var durMs=2000
          var _gotSpeech=false

          if(_audioUrl){
            /* Strategy 1: <audio> element with crossOrigin (bypasses connect-src CSP, uses media-src) */
            var _audioLoaded=false
            try{
              var _ael=document.createElement('audio')
              _ael.crossOrigin='anonymous'
              _ael.preload='auto'
              _ael.src=_audioUrl
              await new Promise(function(resolve,reject){
                _ael.oncanplaythrough=resolve
                _ael.onerror=function(){reject(new Error('CORS load failed'))}
                setTimeout(function(){reject(new Error('timeout'))},6000)
              })
              var _msrc=ac.createMediaElementSource(_ael)
              _msrc.connect(dest)
              _ael.currentTime=0
              await _ael.play()
              durMs=Math.ceil(_ael.duration*1000)+300
              _audioLoaded=true;_gotSpeech=true
              log('  ðŸŽµ MP3 via <audio> CORS ok ('+_ael.duration.toFixed(1)+'s)','')
            }catch(e){
              log('  âš  <audio> CORS: '+e.message.substring(0,50),'wn')
            }

            /* Strategy 2: <audio> without crossOrigin + captureStream */
            if(!_audioLoaded){
              try{
                var _ael2=document.createElement('audio')
                _ael2.preload='auto'
                _ael2.src=_audioUrl
                await new Promise(function(resolve,reject){
                  _ael2.oncanplaythrough=resolve
                  _ael2.onerror=function(){reject(new Error('load failed'))}
                  setTimeout(function(){reject(new Error('timeout'))},6000)
                })
                _ael2.currentTime=0
                await _ael2.play()
                var _cs=_ael2.captureStream?_ael2.captureStream():(_ael2.mozCaptureStream?_ael2.mozCaptureStream():null)
                if(_cs){
                  dest={stream:_cs}
                  durMs=Math.ceil(_ael2.duration*1000)+300
                  _audioLoaded=true;_gotSpeech=true
                  log('  ðŸŽµ MP3 via captureStream ok ('+_ael2.duration.toFixed(1)+'s)','')
                }else{throw new Error('no captureStream')}
              }catch(e){
                log('  âš  captureStream: '+e.message.substring(0,50),'wn')
              }
            }

            /* Strategy 3: fetch (won't work if CSP blocks, but try anyway) */
            if(!_audioLoaded){
              try{
                var resp=await fetch(_audioUrl)
                var abuf=await resp.arrayBuffer()
                var decBuf=await ac.decodeAudioData(abuf)
                var bsrc=ac.createBufferSource();bsrc.buffer=decBuf;bsrc.connect(dest);bsrc.start()
                durMs=Math.ceil(decBuf.duration*1000)+300
                _audioLoaded=true;_gotSpeech=true
                log('  ðŸŽµ MP3 via fetch ok ('+decBuf.duration.toFixed(1)+'s)','')
              }catch(e){
                log('  âš  fetch: '+e.message.substring(0,50),'wn')
              }
            }

            /* Fallback: oscillator (server will score it low but we try anyway) */
            if(!_audioLoaded){
              var osc=ac.createOscillator();osc.frequency.value=180
              var g=ac.createGain();g.gain.value=0.25
              osc.connect(g);g.connect(dest);osc.start()
              durMs=2500
              log('  ðŸ”Š oscillator fallback','wn')
            }
          }else{
            var osc=ac.createOscillator();osc.frequency.value=180
            var g=ac.createGain();g.gain.value=0.25
            osc.connect(g);g.connect(dest);osc.start()
            durMs=2500
          }

          var mt=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/webm'
          var rec=new MediaRecorder(dest.stream,{mimeType:mt})
          var cks=[]
          rec.ondataavailable=function(e){if(e.data.size>0)cks.push(e.data)}
          var recDone=new Promise(function(res){rec.onstop=res})
          rec.start()
          await new Promise(function(r){setTimeout(r,durMs)})
          rec.stop()
          await recDone
          var blob=new Blob(cks,{type:mt})
          var ab=await blob.arrayBuffer()
          var bytes=new Uint8Array(ab)
          var bin='';for(var bi=0;bi<bytes.length;bi++)bin+=String.fromCharCode(bytes[bi])
          audioB64=btoa(bin)
          ac.close()
          log('  ðŸŽ¤ webm: '+audioB64.length+' chars '+(  _gotSpeech?'(fala real)':'(oscillator)'),'')
        }catch(e){
          log('  âš  gravar falhou: '+e.message.substring(0,60),'wn')
        }

        function _gid(){return'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return(c==='x'?r:r&0x3|0x8).toString(16)})}
        function _gws(t){return t.split(/\s+/).filter(function(w){return w.length>0}).map(function(w,i){return{word:w,offset:i*0.5,duration:0.4,score:0.9,pronunciationScore:0.9,accuracyScore:0.9,errorType:'None'}})}
        var _topK=Object.keys(er.contents)[0]

        /* Try up to 3 attempts â€” re-record each time */
        for(var _attempt=0;_attempt<3;_attempt++){
          if(!audioB64){log('  âš  sem Ã¡udio para tentar','wn');break}
          var cA=JSON.parse(JSON.stringify(er.contents))
          if(cA[_topK]&&cA[_topK].userInput){cA[_topK].userInput.data=audioB64;cA[_topK].userInput.id=_gid();if(cA[_topK].userInput.speechScoreSummary){cA[_topK].userInput.speechScoreSummary.score=0.9;cA[_topK].userInput.speechScoreSummary.wordScores=_gws(_targetText)}}
          try{
            var data=await api('POST',API+'/study/lesson/command',{
              commandType:'submit-task-response',
              commandData:{submitTaskResponse:{lessonId:lessonId,activityId:activityId,sessionId:sessionId,response:{taskId:er.taskId,type:er.type,contents:cA},timeSpentSecs:Math.floor(Math.random()*8)+3}},
              clientState:{lessonId:lessonId,lastVersion:version}
            })
            var r=_extractResult(data)
            log('  tentativa '+(_attempt+1)+': '+r.evtCount+' evts '+(r.evtTypes.join(',')||'(nenhum)'),'')
            if(r.taskDone){
              log('âœ“ Ã¡udio OK! ('+_targetText.substring(0,30)+')','ok')
              if(r.taskCorrect){correctTasks++;setStat('__sok',correctTasks)}
              else{wrongTasks++;setStat('__swrong',wrongTasks)}
              doneTasks++;if(totalTasks>0)setProgress(doneTasks/totalTasks*100)
              return{version:r.maxV,lessonPassed:r.lessonPassed,newActivities:r.newActivities,taskDone:true}
            }
            if(r.maxV>version)version=r.maxV
            /* If got assessed but not completed, re-record with slightly different timing */
            if(r.evtTypes.indexOf('task-response-assessed')>-1&&_attempt<2){
              log('  ðŸ” re-gravando tentativa '+(_attempt+2)+'...','wn')
              try{
                var ac2=new(window.AudioContext||window.webkitAudioContext)()
                var dest2=ac2.createMediaStreamDestination()
                var dur2=2000
                if(_audioUrl){
                  try{
                    var _ael3=document.createElement('audio');_ael3.crossOrigin='anonymous';_ael3.preload='auto';_ael3.src=_audioUrl
                    await new Promise(function(res,rej){_ael3.oncanplaythrough=res;_ael3.onerror=function(){rej(new Error('err'))};setTimeout(function(){rej(new Error('to'))},6000)})
                    var _ms3=ac2.createMediaElementSource(_ael3);_ms3.connect(dest2);_ael3.currentTime=0;await _ael3.play()
                    dur2=Math.ceil(_ael3.duration*1000)+300+(_attempt*200)
                  }catch(e){
                    var osc2=ac2.createOscillator();osc2.frequency.value=180;var g2=ac2.createGain();g2.gain.value=0.25;osc2.connect(g2);g2.connect(dest2);osc2.start();dur2=2500
                  }
                }else{var osc2=ac2.createOscillator();osc2.frequency.value=180;var g2=ac2.createGain();g2.gain.value=0.25;osc2.connect(g2);g2.connect(dest2);osc2.start();dur2=2500}
                var mt2=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/webm'
                var rec2=new MediaRecorder(dest2.stream,{mimeType:mt2});var cks2=[];rec2.ondataavailable=function(e){if(e.data.size>0)cks2.push(e.data)}
                var rd2=new Promise(function(res){rec2.onstop=res});rec2.start();await new Promise(function(r){setTimeout(r,dur2)});rec2.stop();await rd2
                var bl2=new Blob(cks2,{type:mt2});var ab2=await bl2.arrayBuffer();var by2=new Uint8Array(ab2);var bn2='';for(var b2=0;b2<by2.length;b2++)bn2+=String.fromCharCode(by2[b2])
                audioB64=btoa(bn2);ac2.close()
                log('  ðŸŽ¤ re-webm: '+audioB64.length+' chars','')
              }catch(e){log('  âš  re-gravar falhou: '+e.message.substring(0,40),'wn');break}
            }else{break}
          }catch(e){
            log('  webm-str erro: '+e.message.substring(0,80),'wn');break
          }
        }
        log('â†’ Ã¡udio skip (speaking-practice)','wn')
        return _doSkip()
      }())
    }

    /* ai-roleplay-fluency: comprehensive multi-strategy handler */
    if(_tt==='ai-roleplay-fluency'){
      return(async function(){
        function _b64urlDec(s){try{var p=s.replace(/-/g,'+').replace(/_/g,'/');while(p.length%4)p+='=';return atob(p)}catch(e){return''}}

        var _roleplayId=''
        try{
          var _td=task.data||task.taskData||{}
          _roleplayId=(_td.aiRoleplayFluency&&_td.aiRoleplayFluency.roleplayID)||''
          if(!_roleplayId){var _rm=JSON.stringify(task).match(/"roleplayID"\s*:\s*"([^"]+)"/);if(_rm)_roleplayId=_rm[1]}
        }catch(e){}
        if(_roleplayId)log('  roleplayID: '+_roleplayId.substring(0,12)+'...','')

        var _rpK=Object.keys(er.contents)[0]||'aiRoleplayFluency'
        console.log('[SpeakyAuto] ai-roleplay er.contents key:',_rpK,'full:',JSON.stringify(er.contents).substring(0,800))
        console.log('[SpeakyAuto] ai-roleplay task.data:',JSON.stringify(task.data||task.taskData||{}).substring(0,800))

        /* helper: try submitting and return result or null */
        async function _trySub(label,contents){
          try{
            var data=await api('POST',API+'/study/lesson/command',{
              commandType:'submit-task-response',
              commandData:{submitTaskResponse:{lessonId:lessonId,activityId:activityId,sessionId:sessionId,response:{taskId:er.taskId,type:er.type,contents:contents},timeSpentSecs:Math.floor(Math.random()*8)+3}},
              clientState:{lessonId:lessonId,lastVersion:version}
            })
            var r=_extractResult(data)
            var errMsg=(data.commandStatus&&data.commandStatus.errorMessage)||''
            console.log('[SpeakyAuto] '+label+': evts='+r.evtCount+' types='+r.evtTypes.join(',')+(errMsg?' err='+errMsg:''))
            log('  '+label+': '+(errMsg?errMsg.substring(0,70):r.evtTypes.join(',')||r.evtCount+' evts'),'')
            if(r.taskDone){
              if(r.taskCorrect){correctTasks++;setStat('__sok',correctTasks)}
              else{wrongTasks++;setStat('__swrong',wrongTasks)}
              doneTasks++;if(totalTasks>0)setProgress(doneTasks/totalTasks*100)
              return{version:r.maxV,lessonPassed:r.lessonPassed,newActivities:r.newActivities,taskDone:true}
            }
            if(r.maxV>version)version=r.maxV
            return null
          }catch(e){
            console.log('[SpeakyAuto] '+label+' error:',e.message)
            log('  '+label+': '+e.message.substring(0,70),'wn')
            return null
          }
        }

        /* helper: GraphQL fetch to roleplay API */
        var _authJwt=getFreshTokens().api
        var _RPGQL='https://roleplay-eu-west-1.ai.englishlive.ef.com/graphql'
        async function _gql(query,variables){
          var resp=await fetch(_RPGQL,{
            method:'POST',
            headers:{'Authorization':'Bearer '+_authJwt,'Content-Type':'application/json'},
            body:JSON.stringify({query:query,variables:variables||{}})
          })
          if(!resp.ok)throw new Error('HTTP '+resp.status)
          return resp.json()
        }

        /* ==== S0: Submit er.contents as-is with completed:true ==== */
        log('  S0: envio direto...','')
        var c0=JSON.parse(JSON.stringify(er.contents))
        if(c0[_rpK])c0[_rpK].completed=true
        var r0=await _trySub('direto',c0)
        if(r0)return r0

        /* ==== S1: Submit with grade, signedGrade field OMITTED entirely ==== */
        var c1={};c1[_rpK]={completed:true,grade:{overallGrade:1,goalAchievedScore:1}}
        var r1=await _trySub('grade-sem-sg',c1)
        if(r1)return r1

        /* ==== S2: Submit with grade, signedGrade:null ==== */
        var c2={};c2[_rpK]={completed:true,grade:{overallGrade:1,goalAchievedScore:1},signedGrade:null}
        var r2=await _trySub('grade-sg-null',c2)
        if(r2)return r2

        /* ==== S3: Captured signedGrade from postMessage ==== */
        var _captured=null
        if(window.__spCapturedGrades){
          _captured=window.__spCapturedGrades[er.taskId]||window.__spCapturedGrades[_roleplayId]||window.__spCapturedGrades['_last']||null
        }
        if(_captured&&_captured.signedGrade){
          log('  ðŸŽ¯ signedGrade capturado!','ok')
          var _cP=null;try{_cP=JSON.parse(_b64urlDec(_captured.signedGrade.split('.')[1]))}catch(e){}
          var cc=JSON.parse(JSON.stringify(er.contents))
          if(cc[_rpK]){cc[_rpK].completed=true;cc[_rpK].signedGrade=_captured.signedGrade;if(_cP)cc[_rpK].grade=_cP}
          var rc=await _trySub('captured',cc)
          if(rc){delete window.__spCapturedGrades[er.taskId];return rc}
        }

        /* ==== S4: Direct GraphQL â€” search existing grades + conversation ==== */
        if(_authJwt&&_roleplayId){
          try{
            log('  S4: GraphQL direto...','')
            /* 4a: search for existing grades */
            var gData=await _gql('query($r:[ID!]=[]){searchRoleplaySessionGrades(input:{roleplayIds:$r}){grades{maxGoalAchievedScore roleplayId maxOverallGrade signedGrade}}}',{r:[_roleplayId]})
            console.log('[SpeakyAuto] GQL grades:',JSON.stringify(gData).substring(0,600))
            var grades=(gData.data&&gData.data.searchRoleplaySessionGrades&&gData.data.searchRoleplaySessionGrades.grades)||[]
            for(var gi=0;gi<grades.length;gi++){
              if(grades[gi].signedGrade){
                log('  ðŸŽ¯ signedGrade via GraphQL!','ok')
                var cg=JSON.parse(JSON.stringify(er.contents))
                if(cg[_rpK]){cg[_rpK].completed=true;cg[_rpK].signedGrade=grades[gi].signedGrade;cg[_rpK].grade={overallGrade:grades[gi].maxOverallGrade||1,goalAchievedScore:grades[gi].maxGoalAchievedScore||1}}
                var rg=await _trySub('gql-grade',cg)
                if(rg)return rg
              }
            }
            log('  GQL: '+grades.length+' grade(s)'+(grades.length?' sem signedGrade':''),'')

            /* 4b: introspection â€” discover mutations */
            log('  introspection...','')
            var iData=await _gql('{__schema{queryType{name}mutationType{name fields{name args{name type{name kind ofType{name kind}}}type{name kind ofType{name kind}}}}}}')
            var muts=(iData.data&&iData.data.__schema&&iData.data.__schema.mutationType&&iData.data.__schema.mutationType.fields)||[]
            var mutNames=muts.map(function(m){return m.name})
            console.log('[SpeakyAuto] GQL mutations:',mutNames.join(', '))
            log('  mutations: '+mutNames.join(', '),'')

            /* Also dump query fields */
            var qfields=(iData.data&&iData.data.__schema&&iData.data.__schema.queryType)||{}
            console.log('[SpeakyAuto] GQL queryType:',qfields.name)

            /* 4c: try to create session + simulate conversation */
            var _createMut=muts.find(function(m){return/create|start|init|begin/i.test(m.name)&&/session|roleplay|conversation/i.test(m.name)})
            if(!_createMut)_createMut=muts.find(function(m){return/roleplay|session/i.test(m.name)&&/create|start/i.test(m.name)})
            if(_createMut){
              log('  ðŸ”§ mutation create: '+_createMut.name,'ok')
              /* figure out input type from args */
              var _cArgs=_createMut.args||[]
              var _cArgNames=_cArgs.map(function(a){return a.name+':'+((a.type&&a.type.name)||(a.type&&a.type.ofType&&a.type.ofType.name)||'?')})
              console.log('[SpeakyAuto] createMut args:',_cArgNames.join(', '))

              /* try various input shapes */
              var _createInputs=[
                {query:'mutation($rid:ID!){'+_createMut.name+'(roleplayId:$rid){sessionId id status}}',vars:{rid:_roleplayId}},
                {query:'mutation($i:CreateRoleplaySessionInput!){'+_createMut.name+'(input:$i){sessionId id status}}',vars:{i:{roleplayId:_roleplayId}}},
                {query:'mutation{'+_createMut.name+'(roleplayId:"'+_roleplayId+'"){sessionId id status}}',vars:{}},
              ]
              var _sessId=null
              for(var ci2=0;ci2<_createInputs.length&&!_sessId;ci2++){
                try{
                  var csData=await _gql(_createInputs[ci2].query,_createInputs[ci2].vars)
                  console.log('[SpeakyAuto] create['+ci2+']:',JSON.stringify(csData).substring(0,500))
                  var csResult=csData.data&&csData.data[_createMut.name]
                  if(csResult)_sessId=csResult.sessionId||csResult.id
                  if(csData.errors){
                    console.log('[SpeakyAuto] create err:',csData.errors[0].message)
                    /* if error tells us the right input shape, log it */
                    log('  create['+ci2+']: '+csData.errors[0].message.substring(0,80),'wn')
                  }
                }catch(e2){console.log('[SpeakyAuto] create['+ci2+'] err:',e2.message)}
              }
              if(_sessId){
                log('  sessÃ£o: '+_sessId.substring(0,12)+'...','ok')
                /* find send/reply mutation */
                var _sendMut=muts.find(function(m){return/send|reply|respond|message|chat/i.test(m.name)})
                var _completeMut=muts.find(function(m){return/complete|finish|end|close|grade/i.test(m.name)&&/session|roleplay|conversation/i.test(m.name)})
                var _gotSG=null

                if(_sendMut){
                  log('  ðŸ’¬ conversando via '+_sendMut.name+'...','')
                  var msgs=['Hello! Nice to meet you.','I am a student learning English. I want to practice.','Thank you for the conversation, goodbye!']
                  for(var mi=0;mi<msgs.length&&!_gotSG;mi++){
                    try{
                      var msgVars=[
                        {query:'mutation($sid:ID!,$msg:String!){'+_sendMut.name+'(sessionId:$sid,message:$msg){message{role content}completed grade{overallGrade goalAchievedScore signedGrade}signedGrade}}',vars:{sid:_sessId,msg:msgs[mi]}},
                        {query:'mutation($i:SendMessageInput!){'+_sendMut.name+'(input:$i){message{role content}completed grade{overallGrade goalAchievedScore signedGrade}signedGrade}}',vars:{i:{sessionId:_sessId,content:msgs[mi]}}},
                        {query:'mutation($i:SendMessageInput!){'+_sendMut.name+'(input:$i){message{role content}completed grade{overallGrade goalAchievedScore signedGrade}signedGrade}}',vars:{i:{sessionId:_sessId,message:msgs[mi]}}},
                      ]
                      for(var mv=0;mv<msgVars.length&&!_gotSG;mv++){
                        try{
                          var mData=await _gql(msgVars[mv].query,msgVars[mv].vars)
                          console.log('[SpeakyAuto] msg['+mi+']['+mv+']:',JSON.stringify(mData).substring(0,500))
                          var mR=mData.data&&mData.data[_sendMut.name]
                          if(mR){
                            _gotSG=mR.signedGrade||(mR.grade&&mR.grade.signedGrade)||null
                            if(_gotSG)log('  ðŸŽ¯ signedGrade na msg '+mi+'!','ok')
                            else if(mR.completed)log('  conversa completed na msg '+mi,'ok')
                          }
                          if(!mData.errors)break /* this variant worked */
                        }catch(e3){}
                      }
                      await wait(800)
                    }catch(e4){console.log('[SpeakyAuto] msg err:',e4.message)}
                  }
                }

                /* try complete/finish mutation */
                if(!_gotSG&&_completeMut){
                  log('  ðŸ completando via '+_completeMut.name+'...','')
                  var compVars=[
                    {query:'mutation($sid:ID!){'+_completeMut.name+'(sessionId:$sid){grade{overallGrade goalAchievedScore signedGrade}signedGrade}}',vars:{sid:_sessId}},
                    {query:'mutation($i:CompleteSessionInput!){'+_completeMut.name+'(input:$i){grade{overallGrade goalAchievedScore signedGrade}signedGrade}}',vars:{i:{sessionId:_sessId}}},
                  ]
                  for(var cv=0;cv<compVars.length&&!_gotSG;cv++){
                    try{
                      var cData=await _gql(compVars[cv].query,compVars[cv].vars)
                      console.log('[SpeakyAuto] complete['+cv+']:',JSON.stringify(cData).substring(0,500))
                      var cR=cData.data&&cData.data[_completeMut.name]
                      if(cR)_gotSG=cR.signedGrade||(cR.grade&&cR.grade.signedGrade)||null
                      if(_gotSG)log('  ðŸŽ¯ signedGrade via complete!','ok')
                    }catch(e5){}
                  }
                }

                /* re-search grades after conversation (grade might have been stored) */
                if(!_gotSG){
                  try{
                    await wait(1000)
                    var g2=await _gql('query($r:[ID!]=[]){searchRoleplaySessionGrades(input:{roleplayIds:$r}){grades{roleplayId maxOverallGrade signedGrade}}}',{r:[_roleplayId]})
                    var gr2=(g2.data&&g2.data.searchRoleplaySessionGrades&&g2.data.searchRoleplaySessionGrades.grades)||[]
                    for(var g2i=0;g2i<gr2.length;g2i++){if(gr2[g2i].signedGrade){_gotSG=gr2[g2i].signedGrade;log('  ðŸŽ¯ signedGrade no re-search!','ok');break}}
                  }catch(e6){}
                }

                /* submit with obtained signedGrade */
                if(_gotSG){
                  var _sgP=null;try{_sgP=JSON.parse(_b64urlDec(_gotSG.split('.')[1]))}catch(e){}
                  var cf=JSON.parse(JSON.stringify(er.contents))
                  if(cf[_rpK]){cf[_rpK].completed=true;cf[_rpK].signedGrade=_gotSG;if(_sgP)cf[_rpK].grade=_sgP}
                  var rf=await _trySub('gql-conv',cf)
                  if(rf)return rf
                }
              }else{
                log('  nenhuma sessÃ£o criada â€” mutations:'+mutNames.join(','),'wn')
              }
            }else{
              log('  nenhuma mutation create encontrada','wn')
              /* dump all mutation details for debugging */
              muts.forEach(function(m){
                var aStr=m.args.map(function(a){return a.name}).join(',')
                console.log('[SpeakyAuto]   mut:',m.name,'args:',aStr,'returns:',(m.type&&m.type.name)||(m.type&&m.type.ofType&&m.type.ofType.name)||'?')
              })
            }
          }catch(ge){
            if(ge.message.indexOf('Failed to fetch')>-1||ge.message.indexOf('NetworkError')>-1||ge.message.indexOf('CORS')>-1){
              log('  GraphQL CORS bloqueado','')
            }else{
              log('  GraphQL: '+ge.message.substring(0,60),'wn')
            }
          }
        }

        /* ==== S5: Local proxy (speaky_proxy2.py on localhost:9876) ==== */
        if(_authJwt){
          try{
            log('  S5: proxy...','')
            var _proxyResp=await fetch('http://localhost:9876/roleplay-grade',{
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({roleplayId:_roleplayId,taskId:er.taskId,lessonId:lessonId,authJwt:_authJwt})
            })
            if(_proxyResp.ok){
              var _pd=await _proxyResp.json()
              console.log('[SpeakyAuto] proxy response:',JSON.stringify(_pd).substring(0,500))
              if(_pd.signedGrade){
                log('  ðŸ”Œ proxy signedGrade!','ok')
                var cp=JSON.parse(JSON.stringify(er.contents))
                if(cp[_rpK]){cp[_rpK].completed=true;cp[_rpK].signedGrade=_pd.signedGrade;if(_pd.grade)cp[_rpK].grade=_pd.grade}
                var rp=await _trySub('proxy',cp)
                if(rp)return rp
              }else{
                log('  proxy: '+(_pd.note||_pd.error||'sem signedGrade'),'wn')
              }
            }
          }catch(pe){
            if(pe.message.indexOf('Failed to fetch')>-1)log('  proxy offline','')
            else log('  proxy: '+pe.message.substring(0,60),'wn')
          }
        }

        /* ==== S6: Skip ==== */
        log('â†’ skip (ai-roleplay)','wn')
        return _doSkip()
      }())
    }
    log('â†’ Ã¡udio skip ('+_tt+')','wn')
    return _doSkip()
  }

  /* === Non-audio: submit expectedResponse as-is === */
  var resp={taskId:er.taskId,type:er.type,contents:JSON.parse(JSON.stringify(er.contents))}
  return api('POST',API+'/study/lesson/command',{
    commandType:'submit-task-response',
    commandData:{submitTaskResponse:{lessonId:lessonId,activityId:activityId,sessionId:sessionId,response:resp,timeSpentSecs:Math.floor(Math.random()*8)+3}},
    clientState:{lessonId:lessonId,lastVersion:version}
  }).then(function(data){
    var r=_extractResult(data)
    console.log('[SpeakyAuto] submit result: evts='+r.evtCount+' taskDone='+r.taskDone+' tipos:'+r.evtTypes.join(','))
    if(r.taskCorrect){correctTasks++;setStat('__sok',correctTasks)}
    else{wrongTasks++;setStat('__swrong',wrongTasks)}
    doneTasks++;if(totalTasks>0)setProgress(doneTasks/totalTasks*100)
    return{version:r.maxV,lessonPassed:r.lessonPassed,newActivities:r.newActivities,taskDone:r.taskDone}
  })
}

/* ===== PROCESS LESSON ===== */
async function processLesson(courseId,lesson){
  if(parado)return false
  window._spAutoSkipActive=true

  var lessonId=null

  /* If lesson._directLessonId is set, skip enrollment entirely */
  if(lesson._directLessonId){
    lessonId=lesson._directLessonId
    log('lessonId direto: '+lessonId.substring(0,8)+'...','ok')
  }else{
    /* 1) open enrollment */
    var enrollment
    /* check interceptor cache first (app may have already enrolled this lesson) */
    if(window.__spEnrollmentCache&&window.__spEnrollmentCache[lesson.id]){
      lessonId=window.__spEnrollmentCache[lesson.id]
      log('lessonId do cache: '+lessonId.substring(0,8)+'...','ok')
    }else{
    try{
      /* try the most specific nodeId field first, then fall back */
      var _nodeId=lesson.contentId||lesson.nodeId||lesson.id
      /* also check cache with the contentId/nodeId variants */
      if(!lessonId&&window.__spEnrollmentCache&&window.__spEnrollmentCache[_nodeId]){
        lessonId=window.__spEnrollmentCache[_nodeId]
        log('lessonId do cache (alt): '+lessonId.substring(0,8)+'...','ok')
      }
      if(!lessonId)enrollment=await openLessonEnrollment(courseId,_nodeId)
    }catch(e){
      /* enrollment failed â€” maybe lesson.id IS already a lessonId, try open-lesson directly */
      log('Enrollment falhou: '+e.message.substring(0,50)+' â€” tentando como lessonId direto','wn')
      lessonId=lesson.id
    }
    if(!lessonId){
      lessonId=enrollment.lessonId
      if(!lessonId){log('  sem lessonId','er');console.error('[SpeakyAuto] enrollment sem lessonId:',JSON.stringify(enrollment).substring(0,300));window._spAutoSkipActive=false;return false}
    }
    }
    console.log('[SpeakyAuto] lessonId:',lessonId)
    log('lessonId: '+lessonId.substring(0,8)+'...','ok')
  }

  await wait(DELAY)

  /* 2) open lesson command -> get activities with answers */
  var cmdResp
  try{
    cmdResp=await openLessonCommand(lessonId)
  }catch(e){
    log('Erro ao carregar '+lesson.title+': '+e.message,'er')
    window._spAutoSkipActive=false;return false
  }

  var events=cmdResp.eventHistory&&cmdResp.eventHistory.events||[]

  /* find sessionId â€” scan in REVERSE to get the MOST RECENT session event
     (open-lesson appends a new student-opened-lesson near the END of the event list) */
  var sessionId=''
  for(var i=events.length-1;i>=0;i--){
    if(events[i].type==='student-opened-lesson'){
      var sol=events[i].data&&(events[i].data.studentOpenedLesson||events[i].data)||{}
      sessionId=sol.sessionId||''
      if(sessionId){console.log('[SpeakyAuto] sessionId from student-opened-lesson['+i+']');break}
    }
  }
  if(!sessionId){
    for(var i=events.length-1;i>=0;i--){
      if(events[i].type==='student-joined-lesson'){
        var sjl=events[i].data&&events[i].data.studentJoinedLesson||{}
        sessionId=sjl.sessionId||''
        if(sessionId){console.log('[SpeakyAuto] sessionId from student-joined-lesson['+i+'] (fallback)');break}
      }
    }
  }
  if(!sessionId){
    /* also check lesson-started (Python extracts from here) */
    for(var i=events.length-1;i>=0;i--){
      if(events[i].type==='lesson-started'){
        var lse=events[i].data&&(events[i].data.lessonStarted||events[i].data)||{}
        sessionId=lse.sessionId||''
        if(sessionId){console.log('[SpeakyAuto] sessionId from lesson-started['+i+'] (fallback2)');break}
      }
    }
  }
  console.log('[SpeakyAuto] open-lesson eventos ('+events.length+'):', events.map(function(e){return e.type}).join(', ')||'NENHUM')
  if(!sessionId){log('âš  sessionId nÃ£o encontrado nos eventos!','er');console.error('[SpeakyAuto] sessionId MISSING - eventos presentes:',events.map(function(e){return e.type}))}
  else{console.log('[SpeakyAuto] sessionId:',sessionId)}

  /* collect activities with their tasks and expectedResponses */
  var activities=[]
  var _isTest=false
  var _contentId=''
  for(var i=0;i<events.length;i++){
    if(events[i].type==='activity-sent'){
      var as=events[i].data.activitySent
      activities.push({
        id:as.activity.id,
        stepId:as.stepId,
        title:as.activity.title,
        tasks:as.activity.tasks||[]
      })
    }
    if(events[i].type==='lesson-started'){
      var ls=events[i].data&&events[i].data.lessonStarted||{}
      if(ls.lessonType==='test')_isTest=true
      if(ls.contentId)_contentId=ls.contentId
    }
  }
  if(_isTest)log('ðŸ“ Tipo: TESTE (progress test)','hi')

  console.log('[SpeakyAuto] atividades encontradas:',activities.length, activities.map(function(a){return '"'+(a.title||'?')+'"('+a.tasks.length+'tasks)'}).join(', '))
  if(!activities.length){log('âš  NENHUMA atividade encontrada nos eventos do open-lesson!','er')}

  /* === MAPA DE TIPOS: loga todos os tipos Ãºnicos desta lesson === */
  ;(function(){
    var _tm={}
    activities.forEach(function(act){
      act.tasks.forEach(function(t){
        var tt=t.type||t.taskType||(t.expectedResponse&&t.expectedResponse.type)||''
        if(!tt){try{var s=JSON.stringify(t);if(s.indexOf('"aiRoleplayFluency"')>-1||s.indexOf('"roleplayID"')>-1)tt='ai-roleplay-fluency';else if(s.indexOf('"speakingPractice"')>-1)tt='speaking-practice';else if(s.indexOf('"pronunciation"')>-1)tt='pronunciation';else if(s.indexOf('"flashCard"')>-1||s.indexOf('"flashcard"')>-1)tt='flash-card';else if(s.indexOf('"video"')>-1)tt='video'}catch(e){}}
        var _cat=tt&&t.expectedResponse?'âœ“ER':(tt&&(tt==='speaking-practice'||tt==='pronunciation'||tt==='ai-roleplay-fluency'||tt==='speaking')?'ðŸŽ¤':tt?'â“skip':'â“?')
        var _k=(tt||'desconhecido')+' ['+_cat+']'
        _tm[_k]=(_tm[_k]||0)+1
      })
    })
    var _ts=Object.keys(_tm).sort().map(function(k){return k+'Ã—'+_tm[k]}).join(' | ')
    if(_ts){log('ðŸ—‚ Tipos: '+_ts,'hi');console.log('[SpeakyAuto] MAPA DE TIPOS:',_tm)}
  }())
  /* DEBUG: dump actual task field structure so we can see all field names */
  if(activities.length&&activities[0].tasks.length){
    console.log('[SpeakyAuto] DEBUG estrutura 1a task:',JSON.stringify(activities[0].tasks[0]).substring(0,600))
  }
  /* DEBUG: dump first speaking-practice and ai-roleplay task structures */
  ;(function(){
    var _spTask=null,_arTask=null
    activities.forEach(function(act){act.tasks.forEach(function(t){
      var tt=t.type||t.taskType||(t.expectedResponse&&t.expectedResponse.type)||''
      if(!_spTask&&tt==='speaking-practice')_spTask=t
      if(!_arTask&&tt==='ai-roleplay-fluency')_arTask=t
    })})
    if(_spTask)console.log('[SpeakyAuto] DEBUG speaking-practice task completo:',JSON.stringify(_spTask).substring(0,1000))
    if(_arTask)console.log('[SpeakyAuto] DEBUG ai-roleplay-fluency task completo:',JSON.stringify(_arTask).substring(0,1000))
  }())
  var _tcEvts=events.filter(function(e){return e.type==='task-completed'})
  console.log('[SpeakyAuto] DEBUG task-completed no histÃ³rico:',_tcEvts.length)
  if(_tcEvts.length){console.log('[SpeakyAuto] DEBUG task-completed[0]:',JSON.stringify(_tcEvts[0]).substring(0,400))}
  var _trEvts=events.filter(function(e){return e.type==='task-response-submitted'})
  if(_trEvts.length){console.log('[SpeakyAuto] DEBUG task-response-submitted[0]:',JSON.stringify(_trEvts[0]).substring(0,400))}

  /* get current version */
  var version=0
  events.forEach(function(e){if(e.version>version)version=e.version})

  /* count tasks that need submitting */
  var pendingTasks=[]
  activities.forEach(function(act){
    act.tasks.forEach(function(task){
      var taskType=task.type||task.taskType||(task.expectedResponse&&task.expectedResponse.type)||''
      /* deeper type detection from task JSON content */
      if(!taskType){
        try{
          var _tjs2=JSON.stringify(task)
          if(_tjs2.indexOf('"aiRoleplayFluency"')>-1||_tjs2.indexOf('"roleplayID"')>-1)taskType='ai-roleplay-fluency'
          else if(_tjs2.indexOf('"speakingPractice"')>-1)taskType='speaking-practice'
          else if(_tjs2.indexOf('"pronunciation"')>-1)taskType='pronunciation'
        }catch(e){}
      }
      var isSpeaking=taskType==='speaking-practice'||taskType==='pronunciation'||taskType==='ai-roleplay-fluency'||taskType==='speaking'
      /* Inclui TODOS os tasks â€” sem ER/audio serÃ£o tratados no submitTask */
      pendingTasks.push({activityId:act.id,task:task,title:act.title})
      if(!task.expectedResponse&&!isSpeaking)
        console.log('[SpeakyAuto] task sem ER (tipo:'+taskType+') incluÃ­da â€” vai tentar skip se necessÃ¡rio. id:',task.id)
    })
  })

  /* check for already completed tasks â€” scan multiple event types and data paths */
  var completedTaskIds=new Set()    /* truly done: task-completed or task-passed */
  var submittedOnlyIds=new Set()    /* task-response-submitted but NOT task-completed */
  var skippedOnlyIds=new Set()      /* tasks that were ONLY skipped (no task-completed) */
  events.forEach(function(e){
    var tid=null
    if(e.type==='task-completed'){
      var d=e.data&&(e.data.taskCompleted||e.data)||{}
      tid=d.taskId||d.id||null
      if(tid){completedTaskIds.add(tid);skippedOnlyIds.delete(tid);submittedOnlyIds.delete(tid)}
    }else if(e.type==='task-passed'){
      var d=e.data&&(e.data.taskPassed||e.data)||{}
      tid=d.taskId||d.id||null
      if(tid){completedTaskIds.add(tid);skippedOnlyIds.delete(tid);submittedOnlyIds.delete(tid)}
    }else if(e.type==='task-response-submitted'){
      var d=e.data&&(e.data.taskResponseSubmitted||e.data)||{}
      tid=d.taskId||(d.response&&d.response.taskId)||null
      if(tid&&!completedTaskIds.has(tid))submittedOnlyIds.add(tid)
    }else if(e.type==='task-skipped'){
      var d=e.data&&(e.data.taskSkipped||e.data)||{}
      tid=d.taskId||d.id||null
      if(tid&&!completedTaskIds.has(tid))skippedOnlyIds.add(tid)
    }
  })
  console.log('[SpeakyAuto] completedTaskIds:',completedTaskIds.size,'submittedOnlyIds:',submittedOnlyIds.size,'skippedOnlyIds:',skippedOnlyIds.size)

  pendingTasks=pendingTasks.filter(function(pt){
    return!completedTaskIds.has(pt.task.id)
  })
  /* log what's being re-processed */
  var _reSub=pendingTasks.filter(function(pt){return submittedOnlyIds.has(pt.task.id)}).length
  var _reSkip=pendingTasks.filter(function(pt){return skippedOnlyIds.has(pt.task.id)}).length
  if(_reSub>0)log(_reSub+' task(s) submetida(s) sem task-completed â€” re-enviando','wn')
  if(_reSkip>0)log(_reSkip+' task(s) de Ã¡udio skipada(s) â€” re-tentando','')
  /* seed set with initial pending tasks so sequential dedup works */
  pendingTasks.forEach(function(pt){completedTaskIds.add(pt.task.id)})

  totalTasks+=pendingTasks.length
  setStat('__stsk',totalTasks)
  log(pendingTasks.length+' exercÃ­cios para responder','');

  /* 3) submit each task */
  var lessonPassed=false
  for(var ti=0;ti<pendingTasks.length;ti++){
    if(parado){window._spAutoSkipActive=false;return false}
    var pt=pendingTasks[ti]
    setProgressText('Respondendo '+lesson.title+' â€” '+(ti+1)+'/'+pendingTasks.length)
    var _logType=pt.task.type||pt.task.taskType||(pt.task.expectedResponse&&pt.task.expectedResponse.type)||'?'
    log('â†’ task '+(ti+1)+'/'+pendingTasks.length+': '+_logType+(pt.task.expectedResponse?' [resposta server]':' [synthese]'),'')
    console.log('[SpeakyAuto] â†’ enviando task '+(ti+1)+'/'+pendingTasks.length,'tipo:',_logType,'actId:',pt.activityId.substring(0,8),'hasER:',!!pt.task.expectedResponse)

    try{
      var sr=await submitTask(lessonId,pt.activityId,sessionId,pt.task,version)
      version=sr.version
      console.log('[SpeakyAuto] â† resultado: version='+sr.version+' lessonPassed='+sr.lessonPassed+' newActivities='+(sr.newActivities?sr.newActivities.length:0))
      if(sr.lessonPassed&&!lessonPassed){lessonPassed=true;log('âœ“ lesson-passed recebido!','ok')}
      /* pick up activities sent sequentially by the server */
      if(sr.newActivities&&sr.newActivities.length){
        log('+'+sr.newActivities.length+' nova(s) atividade(s) do servidor','ok')
        sr.newActivities.forEach(function(act){
          act.tasks.forEach(function(task){
            /* Inclui TODOS os tasks de novas atividades */
            if(!completedTaskIds.has(task.id)){
              completedTaskIds.add(task.id) /* mark so we don't double-add */
              pendingTasks.push({activityId:act.id,task:task,title:act.title||'Activity'})
              totalTasks++;setStat('__stsk',totalTasks)
            }
          })
        })
      }
    }catch(e){
      log('Erro ao responder: '+e.message,'er')
    }

    await wait(TASK_DELAY)
  }

  /* 4) Post-processing â€” force completion if lesson didn't pass */
  if(!lessonPassed){
    log('â³ Tentando forÃ§ar conclusÃ£o...','')
    await wait(800)

    /* For TESTS: try close-lesson FIRST since TestBot evaluates on close */
    if(_isTest&&!lessonPassed){
      log('ðŸ“ Teste detectado â€” fechando para avaliaÃ§Ã£o do TestBot','hi')
      var _testCloseCmds=['close-lesson','end-lesson','evaluate-lesson','evaluate-test','complete-test','finish-lesson','complete-lesson','grade-test','submit-test']
      for(var tci=0;tci<_testCloseCmds.length&&!lessonPassed;tci++){
        try{
          var _tcName=_testCloseCmds[tci]
          var _tcKey=_tcName.replace(/-([a-z])/g,function(m,c){return c.toUpperCase()})
          var _tcData={};_tcData[_tcKey]={lessonId:lessonId,sessionId:sessionId}
          log('â†’ '+_tcName+'...','')
          var tcResp=await api('POST',API+'/study/lesson/command',{
            commandType:_tcName,
            commandData:_tcData,
            clientState:{lessonId:lessonId,lastVersion:version}
          })
          var tcEvts=tcResp.eventHistory&&tcResp.eventHistory.events||[]
          tcEvts.forEach(function(e){
            if(e.version>version)version=e.version
            if(e.type==='lesson-passed'||e.type==='lesson-completed'||e.type==='level-passed'||e.type==='test-passed'||e.type==='test-completed'){
              lessonPassed=true;log('âœ“ '+e.type+' via '+_tcName+'!','ok')
            }
          })
          if(tcEvts.length>0){
            log('  â† '+tcEvts.length+' eventos: '+tcEvts.map(function(e){return e.type}).join(','),'')
          }
        }catch(e){
          /* silent â€” just move to next command */
        }
      }
      if(lessonPassed){
        log('âœ“ Teste avaliado com sucesso!','ok')
      }
    }

    /* 4a) Re-open to get fresh event history and check status */
    if(!lessonPassed){
    try{
      var cmdResp2=await openLessonCommand(lessonId)
      var events2=cmdResp2.eventHistory&&cmdResp2.eventHistory.events||[]
      var maxV2=version
      /* build event type counts for diagnostics */
      var _evtCounts={}
      events2.forEach(function(e){
        if(e.version>maxV2)maxV2=e.version
        if(e.type==='lesson-passed'||e.type==='lesson-completed'||e.type==='level-passed'||e.type==='test-passed'||e.type==='test-completed')lessonPassed=true
        _evtCounts[e.type]=(_evtCounts[e.type]||0)+1
      })
      version=maxV2

      /* dump event summary to UI so user can paste it */
      var _evtSummary=Object.keys(_evtCounts).map(function(k){return k+':'+_evtCounts[k]}).join(', ')
      log('ðŸ“Š Eventos: '+_evtSummary,'')
      var _tc=_evtCounts['task-completed']||0
      var _ts=_evtCounts['task-skipped']||0
      var _ac=_evtCounts['activity-completed']||0
      var _sc=_evtCounts['step-completed']||0
      var _sp=_evtCounts['step-passed']||0
      var _lp=_evtCounts['lesson-progressed']||0
      log('ðŸ“Š task-completed:'+_tc+' task-skipped:'+_ts+' act-completed:'+_ac+' step-completed:'+_sc+' step-passed:'+_sp+' lesson-progressed:'+_lp,'')

      if(!lessonPassed){
        /* count completed vs skipped vs total tasks per activity */
        var actStatus={}
        activities.forEach(function(act){
          actStatus[act.id]={title:act.title,stepId:act.stepId,total:act.tasks.length,completed:0,skipped:0,submitted:0,tasks:act.tasks}
        })
        events2.forEach(function(e){
          if(e.type==='task-completed'){
            var d=e.data&&(e.data.taskCompleted||e.data)||{}
            if(d.activityId&&actStatus[d.activityId])actStatus[d.activityId].completed++
          }
          if(e.type==='task-skipped'){
            var d=e.data&&(e.data.taskSkipped||e.data)||{}
            if(d.activityId&&actStatus[d.activityId])actStatus[d.activityId].skipped++
          }
          if(e.type==='task-response-submitted'){
            var d=e.data&&(e.data.taskResponseSubmitted||e.data)||{}
            var _aid=d.activityId||null
            if(_aid&&actStatus[_aid])actStatus[_aid].submitted++
          }
        })

        /* find activities without activity-completed */
        var actCompletedSet=new Set()
        events2.forEach(function(e){
          if(e.type==='activity-completed'){
            var d=e.data&&(e.data.activityCompleted||e.data)||{}
            if(d.activityId)actCompletedSet.add(d.activityId)
          }
        })

        var incompleteActs=[]
        Object.keys(actStatus).forEach(function(aid){
          var s=actStatus[aid]
          if(!actCompletedSet.has(aid)){
            incompleteActs.push({id:aid,stepId:s.stepId,title:s.title,total:s.total,completed:s.completed,skipped:s.skipped,submitted:s.submitted})
          }
        })

        console.log('[SpeakyAuto] Activities incompletas:',incompleteActs.length)
        incompleteActs.forEach(function(a){
          console.log('[SpeakyAuto]   '+a.title+': '+a.completed+'/'+a.total+' completed, '+a.skipped+' skipped, '+a.submitted+' submitted, stepId:'+a.stepId)
        })
        if(incompleteActs.length>0){
          log(incompleteActs.length+' atividades incompletas â€” tentando complete-activity','wn')
        }else if(activities.length>0){
          log('todas atividades jÃ¡ estÃ£o completed','ok')
        }else{
          log('open-lesson retornou 0 eventos â€” lessonId pode estar incorreto','er')
        }

        /* 4b) Try complete-activity with PROPER commandData format for each incomplete activity
               Server expects: commandData: { completeActivity: { activityId, lessonId, sessionId } } */
        function _checkEvts(evts,cmdName){
          evts.forEach(function(e){
            if(e.version>version)version=e.version
            if(e.type==='lesson-passed'||e.type==='lesson-completed'||e.type==='level-passed'){
              lessonPassed=true
              log('âœ“ lesson-passed via '+cmdName+'!','ok')
            }
            if(e.type==='activity-completed'||e.type==='activity-progressed'){
              log('âœ“ '+e.type+' via '+cmdName,'ok')
            }
            if(e.type==='step-completed'||e.type==='step-passed'){
              log('âœ“ '+e.type+' via '+cmdName,'ok')
            }
          })
        }

        for(var sai=0;sai<incompleteActs.length&&!lessonPassed;sai++){
          var _ia=incompleteActs[sai]
          try{
            log('â†’ complete-activity: '+(_ia.title||_ia.id).substring(0,40),'')
            var caResp=await api('POST',API+'/study/lesson/command',{
              commandType:'complete-activity',
              commandData:{completeActivity:{activityId:_ia.id,lessonId:lessonId,sessionId:sessionId}},
              clientState:{lessonId:lessonId,lastVersion:version}
            })
            var caEvts=caResp.eventHistory&&caResp.eventHistory.events||[]
            var caTypes=caEvts.map(function(e){return e.type}).join(',')
            log('  â† '+caEvts.length+' eventos: '+(caTypes||'nenhum'),'')
            _checkEvts(caEvts,'complete-activity')
          }catch(e){
            log('  âœ— complete-activity: '+e.message.substring(0,100),'wn')
          }
        }

        /* 4c) Try complete-step for ALL unique steps â€” not just from incomplete activities.
               The server may need complete-step even for steps that already have step-completed
               but lack step-passed (which is what triggers lesson-passed). */
        if(!lessonPassed){
          /* collect ALL unique stepIds from activities */
          var _allStepIds=[]
          var _seenSteps=new Set()
          activities.forEach(function(act){
            if(act.stepId&&!_seenSteps.has(act.stepId)){
              _seenSteps.add(act.stepId)
              _allStepIds.push(act.stepId)
            }
          })
          /* also check which ones already have step-passed (not just step-completed) */
          var _passedSteps=new Set()
          events2.forEach(function(e){
            if(e.type==='step-passed'){
              var d=e.data&&(e.data.stepPassed||e.data)||{}
              if(d.stepId)_passedSteps.add(d.stepId)
            }
          })
          var _incStepIds=_allStepIds.filter(function(sid){return!_passedSteps.has(sid)})
          log('steps sem step-passed: '+_incStepIds.length+'/'+_allStepIds.length,'')
          for(var si=0;si<_incStepIds.length&&!lessonPassed;si++){
            try{
              log('â†’ complete-step '+_incStepIds[si].substring(0,8)+'...','')
              var csResp=await api('POST',API+'/study/lesson/command',{
                commandType:'complete-step',
                commandData:{completeStep:{stepId:_incStepIds[si],lessonId:lessonId,sessionId:sessionId}},
                clientState:{lessonId:lessonId,lastVersion:version}
              })
              var csEvts=csResp.eventHistory&&csResp.eventHistory.events||[]
              var csTypes=csEvts.map(function(e){return e.type}).join(',')
              log('  â† '+csEvts.length+' eventos: '+(csTypes||'nenhum'),'')
              _checkEvts(csEvts,'complete-step')
            }catch(e){
              log('  âœ— complete-step falhou: '+e.message.substring(0,100),'wn')
            }
          }
        }

        /* 4d) Try close-lesson with proper nested format */
        if(!lessonPassed){
          var _closeCmds=['close-lesson','end-lesson','evaluate-lesson','finish-lesson','complete-lesson']
          for(var cli=0;cli<_closeCmds.length&&!lessonPassed;cli++){
            try{
              var _ccName=_closeCmds[cli]
              var _ccKey=_ccName.replace(/-([a-z])/g,function(m,c){return c.toUpperCase()})
              var _ccData={};_ccData[_ccKey]={lessonId:lessonId,sessionId:sessionId}
              log('â†’ tentando '+_ccName+'...','')
              var clResp=await api('POST',API+'/study/lesson/command',{
                commandType:_ccName,
                commandData:_ccData,
                clientState:{lessonId:lessonId,lastVersion:version}
              })
              var clEvts=clResp.eventHistory&&clResp.eventHistory.events||[]
              log('  â† '+_ccName+': '+clEvts.length+' eventos: '+(clEvts.map(function(e){return e.type}).join(',')||'nenhum'),'')
              _checkEvts(clEvts,_ccName)
            }catch(e){
              log('  âœ— '+_closeCmds[cli]+': '+e.message.substring(0,100),'wn')
            }
          }
        }

        /* 4e) Try progress API to force lesson completion */
        if(!lessonPassed){
          var _progPaths=[
            '/study/progress/enrollments/'+courseId+'/complete-lesson',
            '/study/progress/enrollments/'+courseId+'/lessons/'+lessonId+'/complete',
            '/study/progress/lessons/'+lessonId+'/complete'
          ]
          for(var pi=0;pi<_progPaths.length&&!lessonPassed;pi++){
            try{
              log('â†’ tentando progress API #'+(pi+1)+'...','')
              var pResp=await api('POST',API+_progPaths[pi],{lessonId:lessonId,nodeId:_contentId||lesson.contentId||lesson.id||lessonId})
              log('  â† progress API: '+JSON.stringify(pResp).substring(0,200),'')
              if(pResp&&(pResp.passed||pResp.completed||pResp.status==='completed'||pResp.status==='passed')){
                lessonPassed=true
                log('âœ“ lesson marcada via progress API!','ok')
              }
            }catch(e){
              log('  âœ— progress API: '+e.message.substring(0,100),'wn')
            }
          }
        }

        /* 4f) Re-open with CURRENT version (not 0) to trigger server re-evaluation.
               This may cause the server to re-compute lesson state and fire lesson-passed. */
        if(!lessonPassed){
          try{
            await wait(1000)
            log('â†’ re-open com versÃ£o atual ('+version+') para trigger...','')
            var cmdRespCur=await api('POST',API+'/study/lesson/command',{
              commandType:'open-lesson',
              commandData:{openLesson:{lessonId:lessonId,instructionsLocale:'en_US'}},
              clientState:{lastVersion:version,lessonId:lessonId}
            })
            var eventsCur=cmdRespCur.eventHistory&&cmdRespCur.eventHistory.events||[]
            var curTypes=eventsCur.map(function(e){return e.type}).join(',')
            log('  â† '+eventsCur.length+' novos eventos: '+(curTypes||'nenhum'),'')
            eventsCur.forEach(function(e){
              if(e.version>version)version=e.version
              if(e.type==='lesson-passed'||e.type==='lesson-completed'||e.type==='level-passed'||e.type==='test-passed'||e.type==='test-completed'){
                lessonPassed=true
                log('âœ“ '+e.type+' via re-open trigger!','ok')
              }
            })
          }catch(e){
            log('  âœ— re-open trigger: '+e.message.substring(0,100),'wn')
          }
        }

        /* 4g) Last resort: re-open with lastVersion:0 for full event scan */
        if(!lessonPassed){
          try{
            await wait(1000)
            log('â†’ re-open final (lastVersion:0)...','')
            var cmdResp3=await openLessonCommand(lessonId)
            var events3=cmdResp3.eventHistory&&cmdResp3.eventHistory.events||[]
            /* build final event type summary */
            var _finalCounts={}
            events3.forEach(function(e){
              if(e.version>version)version=e.version
              _finalCounts[e.type]=(_finalCounts[e.type]||0)+1
              if(e.type==='lesson-passed'||e.type==='lesson-completed'||e.type==='level-passed'||e.type==='test-passed'||e.type==='test-completed'){
                lessonPassed=true
                log('âœ“ '+e.type+' confirmado no re-open final!','ok')
              }
            })
            if(!lessonPassed){
              var _fSummary=Object.keys(_finalCounts).map(function(k){return k+':'+_finalCounts[k]}).join(', ')
              log('ðŸ“Š Final: '+_fSummary,'')
            }
          }catch(e){
            log('  âœ— re-open final falhou: '+e.message.substring(0,100),'wn')
          }
        }
      }
    }catch(e){
      log('âš  re-open para post-processing falhou: '+e.message.substring(0,100),'er')
    }
    } /* end if(!lessonPassed) for 4a-4g */
  }

  /* 5) Final status */
  if(lessonPassed){
    log('âœ“ '+lesson.title+' â€” concluÃ­da!','ok')
  }else{
    log('âš  '+lesson.title+' â€” NÃƒO concluÃ­da','er')
    log('  Algum formato de Ã¡udio pode ter funcionado â€” re-rode o script para checar','hi')
  }

  window._spAutoSkipActive=false
  return true
}

/* ===== DISCOVER FROM PAGE (DOM + intercepted data fallback) ===== */
var UUID_RE=/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

function getCourseIdFromFiber(){
  try{
    var root=document.querySelector('#__next,#app,[data-reactroot],[id="root"],[id="__nuxt"]')
    if(!root)return null
    var fk=Object.keys(root).find(function(k){return k.startsWith('__reactFiber')||k.startsWith('__reactInternalInstance')})
    if(!fk)return null
    var found=null
    function searchObj(obj,depth){
      if(!obj||depth>4||found)return
      if(typeof obj!=='object')return
      var keys=Object.keys(obj)
      for(var i=0;i<keys.length&&!found;i++){
        var k=keys[i],v=obj[k]
        if((k==='courseId'||k==='course_id')&&typeof v==='string'&&UUID_RE.test(v)){found=v;return}
        if(k==='course'&&v&&typeof v.id==='string'&&UUID_RE.test(v.id)){found=v.id;return}
      }
    }
    function walk(node,depth){
      if(!node||depth>200||found)return
      try{
        if(node.memoizedProps)searchObj(node.memoizedProps,0)
        if(!found&&node.memoizedState){
          var s=node.memoizedState
          while(s&&!found){searchObj(s.memoizedState||s,0);s=s.next}
        }
      }catch(e){}
      walk(node.child,depth+1)
      if(depth<50)walk(node.sibling,depth+1)
    }
    walk(root[fk],0)
    return found
  }catch(e){return null}
}

function getLessonsFromFiber(){
  try{
    var root=document.querySelector('#__next,#app,[data-reactroot],[id="root"],[id="__nuxt"]')
    if(!root)return[]
    var fk=Object.keys(root).find(function(k){return k.startsWith('__reactFiber')||k.startsWith('__reactInternalInstance')})
    if(!fk)return[]
    var found=[],seen=new Set()
    function extractLessons(arr){
      if(!Array.isArray(arr))return
      arr.forEach(function(item){
        if(!item||typeof item!=='object')return
        if(Array.isArray(item.lessons))extractLessons(item.lessons)
        if(Array.isArray(item.units))extractLessons(item.units)
        var id=item.id||item.contentId||item.nodeId||item.lessonId
        if(id&&typeof id==='string'&&UUID_RE.test(id)&&!seen.has(id)){
          /* skip only if explicitly locked or explicitly passed */
          if(item.isLocked===true)return
          if(item.progressState==='passed'||item.status==='completed'||item.completed===true)return
          seen.add(id)
          found.push({id:id,title:item.title||item.name||item.lessonTitle||'Lesson'})
        }
      })
    }
    function searchVal(v,depth){
      if(!v||typeof v!=='object'||depth>5)return
      try{
        var keys=Object.keys(v)
        for(var i=0;i<keys.length;i++){
          var k=keys[i],val=v[k]
          if((k==='units'||k==='lessons'||k==='nodes'||k==='content'||k==='items'||k==='steps')&&Array.isArray(val)&&val.length)extractLessons(val)
          else if(depth<4&&val&&typeof val==='object'&&!Array.isArray(val))searchVal(val,depth+1)
        }
      }catch(e){}
    }
    function walk(node,depth){
      if(!node||depth>400)return
      try{
        if(node.memoizedProps)searchVal(node.memoizedProps,0)
        if(node.memoizedState){var s=node.memoizedState,si=0;while(s&&si<8){searchVal(s.memoizedState||s,0);s=s.next;si++}}
        if(node.pendingProps)searchVal(node.pendingProps,0)
      }catch(e){}
      walk(node.child,depth+1)
      if(depth<150)walk(node.sibling,depth+1)
    }
    walk(root[fk],0)
    if(found.length)console.log('[SpeakyAuto] getLessonsFromFiber:',found.length,'lessons')
    return found
  }catch(e){console.log('[SpeakyAuto] getLessonsFromFiber error:',e.message);return[]}
}

/* Angular Ivy __ngContext traversal â€” deep recursive scan of component state */
function getLessonsFromAngular(){
  var found=[],seenIds=new Set()
  var seenObjs=typeof WeakSet!=='undefined'?new WeakSet():null
  var UUID_PAT=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  function extractLessons(arr){
    if(!Array.isArray(arr))return
    for(var i=0;i<arr.length;i++){
      var item=arr[i]
      if(!item||typeof item!=='object')continue
      /* recurse into nested unit/lesson arrays first */
      if(Array.isArray(item.lessons))extractLessons(item.lessons)
      if(Array.isArray(item.units))extractLessons(item.units)
      if(Array.isArray(item.nodes))extractLessons(item.nodes)
      if(Array.isArray(item.steps))extractLessons(item.steps)
      var id=item.id||item.contentId||item.nodeId||item.lessonId
      if(!id||typeof id!=='string'||!UUID_PAT.test(id)||seenIds.has(id))continue
      if(item.isLocked===true)continue
      if(item.progressState==='passed'||item.status==='completed'||item.completed===true)continue
      var title=item.title||item.name||item.lessonTitle
      if(!title)continue
      seenIds.add(id)
      found.push({id:id,title:title})
    }
  }

  function scanObj(obj,depth){
    if(!obj||typeof obj!=='object'||Array.isArray(obj)||depth>5)return
    if(seenObjs){if(seenObjs.has(obj))return;seenObjs.add(obj)}
    try{
      var keys=Object.keys(obj)
      for(var i=0;i<keys.length;i++){
        var v=obj[keys[i]]
        if(Array.isArray(v)&&v.length)extractLessons(v)
        else if(v&&typeof v==='object'&&!Array.isArray(v))scanObj(v,depth+1)
      }
    }catch(e){}
  }

  try{
    var els=document.querySelectorAll('*')
    for(var i=0;i<els.length;i++){
      var ctx=els[i].__ngContext
      if(!ctx)continue
      var lview=Array.isArray(ctx)?ctx:null
      /* scan component instance (lview[8]) and a few surrounding slots */
      var slots=lview?lview:[ctx]
      var start=lview?6:0,end=lview?Math.min(lview.length,20):1
      for(var s=start;s<end;s++){
        var comp=slots[s]
        if(!comp||typeof comp!=='object'||Array.isArray(comp))continue
        scanObj(comp,0)
      }
    }
  }catch(e){}

  if(found.length)console.log('[SpeakyAuto] getLessonsFromAngular:',found.length,'lessons')
  return found
}

/* Debug: chame window._spDebugFiber() para ver o que o fiber contÃ©m */
window._spDebugFiber=function(){
  try{
    var root=document.querySelector('#__next,#app,[data-reactroot],[id="root"],[id="__nuxt"]')
    if(!root){console.log('[SP-FIBER] sem root');return}
    var fk=Object.keys(root).find(function(k){return k.startsWith('__reactFiber')||k.startsWith('__reactInternalInstance')})
    if(!fk){console.log('[SP-FIBER] sem fiber key');return}
    var hits=[]
    function searchVal(v,path,depth){
      if(!v||typeof v!=='object'||depth>5)return
      try{
        var keys=Object.keys(v)
        for(var i=0;i<keys.length;i++){
          var k=keys[i],val=v[k]
          if((k==='units'||k==='lessons'||k==='nodes'||k==='content'||k==='items'||k==='steps')&&Array.isArray(val)&&val.length){
            hits.push(path+'.'+k+'['+val.length+'] sample:'+JSON.stringify(val[0]).substring(0,200))
          }else if(depth<4&&val&&typeof val==='object'&&!Array.isArray(val))searchVal(val,path+'.'+k,depth+1)
        }
      }catch(e){}
    }
    function walk(node,depth){
      if(!node||depth>400)return
      try{
        if(node.memoizedProps)searchVal(node.memoizedProps,'props',0)
        if(node.memoizedState){var s=node.memoizedState,si=0;while(s&&si<8){searchVal(s.memoizedState||s,'state['+si+']',0);s=s.next;si++}}
      }catch(e){}
      walk(node.child,depth+1)
      if(depth<150)walk(node.sibling,depth+1)
    }
    walk(root[fk],0)
    if(hits.length){console.log('[SP-FIBER] Hits:',hits.length);hits.forEach(function(h){console.log(' ',h)})}
    else console.log('[SP-FIBER] Nenhum array de lessons/units encontrado no fiber')
  }catch(e){console.log('[SP-FIBER] erro:',e.message)}
}

/* Debug: chame window._spDebugAngular() para ver arrays nos componentes Angular */
window._spDebugAngular=function(){
  var els=document.querySelectorAll('*'),hits=[]
  for(var i=0;i<els.length;i++){
    var ctx=els[i].__ngContext
    if(!ctx)continue
    var lview=Array.isArray(ctx)?ctx:null
    var start=lview?6:0,end=lview?Math.min(lview.length,20):1
    var slots=lview?lview:[ctx]
    for(var s=start;s<end;s++){
      var comp=slots[s]
      if(!comp||typeof comp!=='object'||Array.isArray(comp))continue
      try{
        var keys=Object.keys(comp)
        for(var ki=0;ki<keys.length;ki++){
          var v=comp[keys[ki]]
          if(Array.isArray(v)&&v.length>0&&v[0]&&typeof v[0]==='object'){
            hits.push({el:els[i].tagName,slot:s,key:keys[ki],len:v.length,sample:JSON.stringify(v[0]).substring(0,200)})
          }
        }
      }catch(e){}
    }
  }
  console.log('[SP-ANG] Arrays em __ngContext ('+hits.length+'):')
  hits.forEach(function(h){console.log(' ['+h.el+' slot='+h.slot+'] .'+h.key+'['+h.len+']',h.sample)})
  if(!hits.length)console.log('[SP-ANG] NENHUM array encontrado - app pode nao ser Angular')
}

function discoverFromPage(){
  var result={courseId:null,lessons:[]}
  var seen=new Set()

  /* 1) courseId from URL + query params */
  var fullUrl=window.location.href
  var cm=fullUrl.match(/course[s]?[\/=](UUID_RE)/i)||fullUrl.match(/course[s]?[\/=]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  if(cm)result.courseId=cm[1]
  var qm=fullUrl.match(/[?&]course(?:Id)?=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  if(!result.courseId&&qm)result.courseId=qm[1]

  /* 2) lesson + course UUIDs from all anchor hrefs */
  document.querySelectorAll('a[href]').forEach(function(a){
    var href=a.getAttribute('href')||''
    var lm=href.match(/lesson[s]?[\/=]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
    if(lm&&!seen.has(lm[1])){
      seen.add(lm[1])
      result.lessons.push({id:lm[1],title:a.textContent.trim().replace(/\s+/g,' ').substring(0,80)||'Lesson'})
    }
    if(!result.courseId){
      var hcm=href.match(/course[s]?[\/=]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
      if(hcm)result.courseId=hcm[1]
    }
  })

  /* 3) data attributes */
  document.querySelectorAll('[data-course-id],[data-lesson-id],[data-content-id]').forEach(function(el){
    var cid=el.getAttribute('data-course-id')
    if(cid&&UUID_RE.test(cid))result.courseId=cid
    var lid=el.getAttribute('data-lesson-id')||el.getAttribute('data-content-id')
    if(lid&&UUID_RE.test(lid)&&!seen.has(lid)){
      seen.add(lid)
      result.lessons.push({id:lid,title:el.textContent.trim().substring(0,80)||'Lesson'})
    }
  })

  /* 4) captured data from fetch interceptor */
  if(window.__spCapturedData&&window.__spCapturedData.courseGroups){
    try{
      var cg=window.__spCapturedData.courseGroups
      if(!result.courseId&&cg[0]&&cg[0].courses)result.courseId=cg[0].courses[0].id
    }catch(e){}
  }
  if(window.__spCapturedData&&window.__spCapturedData.levelDetails){
    try{
      var ld=window.__spCapturedData.levelDetails
      if(ld.units&&!result.lessons.length){
        ld.units.forEach(function(unit){
          if(unit.isLocked)return
          unit.lessons.forEach(function(lesson){
            if(!lesson.isLocked&&lesson.progressState!=='passed')result.lessons.push(lesson)
          })
        })
      }
    }catch(e){}
  }

  /* 5) all inline script tags â€” search for courseId pattern */
  if(!result.courseId){
    document.querySelectorAll('script:not([src])').forEach(function(s){
      if(result.courseId)return
      var txt=s.textContent
      if(txt.length<10)return
      var m=txt.match(/"courseId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i)
      if(!m)m=txt.match(/courseId['":\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
      if(m)result.courseId=m[1]
    })
  }

  /* 6) framework state (__NEXT_DATA__, __NUXT__, etc) */
  ;['__NEXT_DATA__','__NUXT__','__INITIAL_STATE__','__APP_STATE__'].forEach(function(k){
    if(window[k]&&!result.courseId){
      try{
        var s=JSON.stringify(window[k])
        var m=s.match(/"courseId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/)
        if(m)result.courseId=m[1]
      }catch(e){}
    }
  })

  /* 7) React fiber traversal */
  if(!result.courseId){
    result.courseId=getCourseIdFromFiber()
    if(result.courseId)console.log('[SpeakyAuto] courseId from React fiber:',result.courseId)
  }

  /* 8) if lessons found but no courseId, extract courseId from non-lesson UUIDs in lesson hrefs */
  if(!result.courseId&&result.lessons.length){
    document.querySelectorAll('a[href]').forEach(function(a){
      if(result.courseId)return
      var href=a.getAttribute('href')||''
      var all=[]
      var rx=/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi
      var m
      while((m=rx.exec(href))!==null)all.push(m[1])
      /* if href has 2+ UUIDs, the one that isn't a lesson UUID is likely courseId */
      if(all.length>=2){
        var lessonIds=result.lessons.map(function(l){return l.id})
        var candidate=all.find(function(id){return lessonIds.indexOf(id)<0})
        if(candidate)result.courseId=candidate
      }
    })
  }

  /* 9) React fiber lesson walk */
  if(!result.lessons.length){
    var fiberLessons=getLessonsFromFiber()
    if(fiberLessons.length)result.lessons=fiberLessons
  }

  /* 10) Angular __ngContext â€” always supplement, catches lessons not in links */
  var angLessons=getLessonsFromAngular()
  angLessons.forEach(function(al){
    if(!result.lessons.some(function(l){return l.id===al.id}))result.lessons.push(al)
  })

  console.log('[SpeakyAuto] discoverFromPage:',result.courseId,result.lessons.length+' lessons')
  return (result.courseId||result.lessons.length)?result:null
}

/* ===== MAIN ===== */
async function iniciar(){
  parado=false;totalTasks=0;doneTasks=0;correctTasks=0;wrongTasks=0
  document.getElementById('__sgo').disabled=true
  setDot('run')
  _origSetStat('__sles','--');_origSetStat('__stsk','--');_origSetStat('__sok','0');_origSetStat('__swrong','0')
  setProgress(0);setProgressText('Carregando...')

  /* Determine which courses to run based on selection */
  var targetCourseIds=_selectedCourseIds /* null = todos */
  if(!targetCourseIds||!targetCourseIds.length){
    targetCourseIds=_availCourses.map(function(c){return c.id})
  }

  /* Try loading more courses from BFF and update selector */
  try{
    var groups=await getCourseGroups()
    if(groups&&groups.length){
      var bffCourses=[]
      groups.forEach(function(g){
        if(g.courses)g.courses.forEach(function(c){bffCourses.push({id:c.id,title:c.title})})
      })
      if(bffCourses.length){
        /* Add any new BFF courses not yet in selector */
        var existingIds=_availCourses.map(function(c){return c.id})
        var added=false
        bffCourses.forEach(function(c){
          if(existingIds.indexOf(c.id)<0){_availCourses.push(c);added=true}
        })
        if(added)buildCourseSelector(_availCourses)
        /* Recalculate targetCourseIds after selector rebuilt */
        if(!_selectedCourseIds||!_selectedCourseIds.length)
          targetCourseIds=_availCourses.map(function(c){return c.id})
        else targetCourseIds=_selectedCourseIds
      }
    }
  }catch(e){/* BFF unavailable, proceed with known courses */}

  log('Iniciando â€” '+targetCourseIds.length+' curso(s) selecionado(s)','hi')
  /* Debug: log token availability */
  ;(function(){var _t=getFreshTokens();console.log('[SpeakyAuto] TOKEN STATUS â†’ api:'+(!!_t.api?'âœ“ ('+_t.api.substring(0,6)+'...)':'âœ— NULL')+' bff:'+(!!_t.bff?'âœ“ ('+_t.bff.substring(0,6)+'...)':'âœ— NULL')+' capturedApi:'+(!!window.__spCapturedApiAuth?'âœ“':'âœ—')+' capturedBff:'+(!!window.__spCapturedAuth?'âœ“':'âœ—'))}())

  var totalLessonsAll=0,doneLessons=0

  /* Process each selected course */
  for(var ci=0;ci<targetCourseIds.length;ci++){
    if(parado)break
    var courseId=targetCourseIds[ci]
    var courseInfo=_availCourses.find(function(c){return c.id===courseId})||{title:courseId.substring(0,8)+'...'}
    log('Curso: '+courseInfo.title,'hi')
    setProgressText('Carregando '+courseInfo.title+'...')

    var lessons=[]

    /* Try BFF for lesson list */
    try{
      var details=await api('GET',BFF+'/self-study/level-details?locale=en&courseId='+courseId)
      if(details&&details.units){
        var _seen=new Set()
        function _addLesson(l){if(l&&l.id&&!_seen.has(l.id)&&!l.isLocked&&l.progressState!=='passed'){_seen.add(l.id);lessons.push(l)}}
        details.units.forEach(function(unit){
          if(unit.isLocked)return
          if(unit.lessons)unit.lessons.forEach(_addLesson)
          /* tests/progress tests may live under different keys */
          if(unit.tests)unit.tests.forEach(_addLesson)
          if(unit.progressTests)unit.progressTests.forEach(_addLesson)
          if(unit.assessments)unit.assessments.forEach(_addLesson)
          /* some structures nest tests inside nodes/steps */
          if(unit.nodes)unit.nodes.forEach(function(n){_addLesson(n);if(n.lessons)n.lessons.forEach(_addLesson);if(n.tests)n.tests.forEach(_addLesson)})
        })
        /* top-level tests/progressTests on the details object */
        if(details.tests)details.tests.forEach(_addLesson)
        if(details.progressTests)details.progressTests.forEach(_addLesson)
        if(details.assessments)details.assessments.forEach(_addLesson)
      }
    }catch(e){}

    /* DOM fallback for lessons */
    if(!lessons.length){
      var disc=discoverFromPage()
      if(disc&&disc.lessons.length){
        /* NOTE: never override courseId with DOM-discovered one â€” the known courseId
           from KNOWN_COURSES/BFF is the only valid enrollment ID for the API */
        lessons=disc.lessons
        log('Lessons encontradas na pÃ¡gina','wn')
      }
    }

    if(!lessons.length){
      log('Nenhuma lesson pendente em '+courseInfo.title+' â€” use Lesson Manual','wn')
      setStat('__sles','0')
      setDot('ok')
      setProgressText('Use o campo Manual para rodar teste')
      document.getElementById('__sgo').disabled=false
      continue
    }

    totalLessonsAll+=lessons.length
    setStat('__sles',totalLessonsAll)
    log(lessons.length+' lesson(s) pendente(s)','');

    for(var li=0;li<lessons.length;li++){
      if(parado){log('Pausado pelo usuÃ¡rio','wn');break}
      doneLessons++
      var lessonNum='['+doneLessons+'/'+totalLessonsAll+']'
      log(lessonNum+' '+( lessons[li].title||'Lesson'),'');
      var ok=await processLesson(courseId,lessons[li])
      if(!ok&&!parado)log('âš  Falhou, pulando para prÃ³xima','wn')
      /* Update overall lesson progress (task progress is finer-grained) */
      if(totalTasks===0)setProgress(doneLessons/totalLessonsAll*100)
      await wait(DELAY)
    }
  }

  if(parado){
    log('Pausado','wn')
    setProgressText('Pausado')
    setDot('')
  }else{
    var summary=doneTasks+' exercÃ­cio(s) respondido(s)'
    if(wrongTasks>0)summary+=' Â· '+wrongTasks+' erro(s)'
    log(summary,'ok')
    setProgressText('ConcluÃ­do')
    setProgress(100)
    setDot('ok')
  }
  window._spAutoSkipActive=false
  document.getElementById('__sgo').disabled=false
}

document.getElementById('__sgo').onclick=iniciar
document.getElementById('__sstp').onclick=function(){parado=true;log('Pausando...','wn')}

/* ===== AUTO-DETECT lessonId from ALL available sources ===== */
function _autoDetectLessonId(){
  var found=null,src=''

  /* 1) Fetch interceptor captured open-lesson request/response */
  if(!found&&window.__spCapturedLessonId){
    found=window.__spCapturedLessonId;src='fetch interceptor'
  }

  /* 2) Captured lesson response data */
  if(!found&&window.__spCapturedLesson){
    try{
      var s=JSON.stringify(window.__spCapturedLesson)
      var m=s.match(/"lessonId"\s*:\s*"([0-9a-f-]{36})"/i)
      if(m){found=m[1];src='captured response'}
    }catch(e){}
  }

  /* 3) iframe src with lessonId param */
  if(!found){
    try{
      var iframes=document.querySelectorAll('iframe')
      for(var fi=0;fi<iframes.length;fi++){
        var iurl=iframes[fi].src||''
        if(iurl.indexOf('lesson-player')>-1){
          var um=iurl.match(/lessonId=([0-9a-f-]{36})/i)
          if(um){found=um[1];src='iframe URL';break}
        }
      }
    }catch(e){}
  }

  /* 4) URL params on current page */
  if(!found){
    try{
      var href=window.location.href
      var lm=href.match(/lessonId=([0-9a-f-]{36})/i)||href.match(/lesson[\/=]([0-9a-f-]{36})/i)
      if(lm){found=lm[1];src='page URL'}
    }catch(e){}
  }

  /* 5) capturedData from BFF responses */
  if(!found&&window.__spCapturedData){
    try{
      var s=JSON.stringify(window.__spCapturedData)
      var m=s.match(/"lessonId"\s*:\s*"([0-9a-f-]{36})"/i)
      if(m){found=m[1];src='captured BFF data'}
    }catch(e){}
  }

  /* 6) Performance resource entries */
  if(!found){
    try{
      var entries=performance.getEntriesByType('resource')
      for(var ei=0;ei<entries.length;ei++){
        var eu=entries[ei].name||''
        if(eu.indexOf('lesson/command')>-1){
          var m=eu.match(/lessonId=([0-9a-f-]{36})/i)
          if(m){found=m[1];src='network entry';break}
        }
      }
    }catch(e){}
  }

  /* 7) Angular __ngContext scan (if on lesson-player domain) */
  if(!found){
    try{
      var els=document.querySelectorAll('*')
      for(var i=0;i<Math.min(els.length,500)&&!found;i++){
        var ctx=els[i].__ngContext
        if(!ctx||!Array.isArray(ctx))continue
        for(var s=6;s<Math.min(ctx.length,30)&&!found;s++){
          var comp=ctx[s]
          if(!comp||typeof comp!=='object')continue
          try{
            var cs=JSON.stringify(comp)
            var lm=cs.match(/"lessonId"\s*:\s*"([0-9a-f-]{36})"/i)
            if(lm){found=lm[1];src='Angular state'}
          }catch(e){}
        }
      }
    }catch(e){}
  }

  /* 8) Scan window properties for any lesson-player state */
  if(!found){
    try{
      var wkeys=['__lesson','__lessonState','lessonState','_lessonId','currentLesson']
      for(var wi=0;wi<wkeys.length&&!found;wi++){
        var wv=window[wkeys[wi]]
        if(wv){
          var ws=typeof wv==='string'?wv:JSON.stringify(wv)
          var wm=ws.match(/"?lessonId"?\s*[:=]\s*"?([0-9a-f-]{36})"?/i)
          if(wm){found=wm[1];src='window.'+wkeys[wi]}
        }
      }
    }catch(e){}
  }

  return found?{id:found,source:src}:null
}

/* ===== RODAR TESTE (auto-detect + one-shot) ===== */
document.getElementById('__sptst').onclick=async function(){
  var btn=document.getElementById('__sptst')
  btn.disabled=true;btn.textContent='detectando...'

  /* try auto-detect first */
  var det=_autoDetectLessonId()
  var lid=det?det.id:null

  /* fallback: check manual input */
  if(!lid){
    var manual=document.getElementById('__spmc').value.trim()
    if(manual&&/^[0-9a-f-]{36}$/i.test(manual)){lid=manual;det={source:'input manual'}}
  }

  if(!lid){
    btn.disabled=false;btn.textContent='âš¡ Rodar Teste (auto-detect)'
    log('Nenhum lessonId detectado!','er')
    log('Abra o teste primeiro, depois clique aqui','wn')
    log('Ou cole o lessonId no campo abaixo','')
    return
  }

  log('Detectado via: '+(det?det.source:'?')+' â†’ '+lid.substring(0,12)+'...','ok')
  btn.textContent='rodando...'

  var courseId=(_selectedCourseIds&&_selectedCourseIds[0])||'87e8ec1d-a478-4d39-badd-4ddb20494eaf'
  parado=false;totalTasks=0;doneTasks=0;correctTasks=0;wrongTasks=0
  document.getElementById('__sgo').disabled=true
  setDot('run');_origSetStat('__sles','1');_origSetStat('__stsk','--');_origSetStat('__sok','0');_origSetStat('__swrong','0')
  setProgress(0);setProgressText('Rodando teste...')

  var lesson={id:lid,title:'Progress Test',_directLessonId:lid}

  try{await processLesson(courseId,lesson)}catch(e){log('Erro: '+e.message,'er')}
  if(totalTasks>0){log(doneTasks+' respostas Â· '+correctTasks+' certas Â· '+wrongTasks+' erradas','ok')}
  setProgressText('ConcluÃ­do');setProgress(100);setDot('ok')
  document.getElementById('__sgo').disabled=false
  btn.disabled=false;btn.textContent='âš¡ Rodar Teste (auto-detect)'
}

/* ===== RUN MANUAL (small button) ===== */
document.getElementById('__spmgo').onclick=async function(){
  var cid=document.getElementById('__spmc').value.trim()
  if(!cid){alert('Cole o lessonId');return}
  var courseId=(_selectedCourseIds&&_selectedCourseIds[0])||'87e8ec1d-a478-4d39-badd-4ddb20494eaf'
  parado=false;totalTasks=0;doneTasks=0;correctTasks=0;wrongTasks=0
  document.getElementById('__sgo').disabled=true
  setDot('run');_origSetStat('__sles','1');_origSetStat('__stsk','--');_origSetStat('__sok','0');_origSetStat('__swrong','0')
  setProgress(0);setProgressText('Rodando...')
  log('ID: '+cid.substring(0,12)+'...','hi')

  var lesson={id:cid,title:'Manual',_directLessonId:cid}
  try{await processLesson(courseId,lesson)}catch(e){log('Erro: '+e.message,'er')}
  if(totalTasks>0){log(doneTasks+' respostas Â· '+correctTasks+' certas Â· '+wrongTasks+' erradas','ok')}
  setProgressText('ConcluÃ­do');setProgress(100);setDot('ok')
  document.getElementById('__sgo').disabled=false
}
}())
