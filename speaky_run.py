#!/usr/bin/env python3
"""
Speaky automation — login via stealth browser, completa todas as lições via API.

Uso: python speaky_run.py <email> <senha> [capsolver_key]
     CAPSOLVER_KEY=xxx python speaky_run.py email senha

Captchas suportados:
  1. Cloudflare managed challenge — playwright-stealth (automático)
  2. reCAPTCHA v2/v3 — CapSolver API (requer CAPSOLVER_KEY)
  3. Cloudflare Turnstile — CapSolver API (requer CAPSOLVER_KEY)

pip install playwright playwright-stealth requests
python -m playwright install chromium
"""

import asyncio, json, sys, os, time, random, base64, re, uuid as _uuid_mod
import threading, ssl
from urllib.request import urlopen, Request
from urllib.error import HTTPError

# ─── Auto-install ─────────────────────────────────────────────
def _pip(*pkgs):
    import subprocess
    for p in pkgs:
        mod = p.split('[')[0].split('>=')[0].replace('-', '_')
        try:
            __import__(mod)
        except ImportError:
            print(f'[SP] instalando {p}...', flush=True)
            subprocess.check_call([sys.executable, '-m', 'pip', 'install', p, '-q'])
_pip('playwright', 'requests', 'cloudscraper')

try:
    _pip('playwright_stealth')
    from playwright_stealth import stealth_async
    _STEALTH = True
except Exception:
    _STEALTH = False

from playwright.async_api import async_playwright
import requests as _req

_ssl_ctx = ssl.create_default_context()

# ─── Config ───────────────────────────────────────────────────
API = 'https://api.study.better.efekta.com'
BFF = 'https://learn.better.efekta.com/gap/bff/api/v1'
CAPSOLVER_KEY = os.environ.get('CAPSOLVER_KEY', '')

# ─── SED / EduSP SSO ─────────────────────────────────────────
SED_LOGIN_URL = 'https://sedintegracoes.educacao.sp.gov.br/credenciais/api/LoginCompletoToken'
SED_OCP_KEY   = '2b03c1db3884488795f79c37c069381a'
EDUSP_API_URL = 'https://edusp-api.ip.tv'
_SED_HEADERS  = {
    'Content-Type':              'application/json',
    'Accept':                    'application/json, text/plain, */*',
    'Ocp-Apim-Subscription-Key': SED_OCP_KEY,
    'Origin':                    'https://saladofuturo.educacao.sp.gov.br',
    'Referer':                   'https://saladofuturo.educacao.sp.gov.br/',
    'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
}

# ─── CapSolver ────────────────────────────────────────────────
def _capsolver_create(task_body, api_key):
    payload = json.dumps({'clientKey': api_key, 'task': task_body}).encode()
    req = Request('https://api.capsolver.com/createTask', payload, {'Content-Type': 'application/json'})
    r = urlopen(req, context=_ssl_ctx, timeout=15)
    return json.loads(r.read())

def _capsolver_poll(task_id, api_key, max_wait=90):
    payload = json.dumps({'clientKey': api_key, 'taskId': task_id}).encode()
    req_obj = Request('https://api.capsolver.com/getTaskResult', payload, {'Content-Type': 'application/json'})
    for _ in range(max_wait // 3):
        time.sleep(3)
        r = urlopen(req_obj, context=_ssl_ctx, timeout=15)
        data = json.loads(r.read())
        if data.get('status') == 'ready':
            return data.get('solution') or {}
    return {}

def _solve_recaptcha_v2(site_key, page_url, api_key):
    try:
        d = _capsolver_create({'type': 'ReCaptchaV2TaskProxyless', 'websiteURL': page_url, 'websiteKey': site_key}, api_key)
        tid = d.get('taskId')
        if not tid:
            return None
        sol = _capsolver_poll(tid, api_key)
        return sol.get('gRecaptchaResponse')
    except Exception as e:
        return None

def _solve_recaptcha_v3(site_key, page_url, action, api_key):
    try:
        d = _capsolver_create({'type': 'ReCaptchaV3TaskProxyless', 'websiteURL': page_url, 'websiteKey': site_key, 'pageAction': action or 'login'}, api_key)
        tid = d.get('taskId')
        if not tid:
            return None
        sol = _capsolver_poll(tid, api_key)
        return sol.get('gRecaptchaResponse')
    except Exception as e:
        return None

def _solve_turnstile(site_key, page_url, api_key):
    try:
        d = _capsolver_create({'type': 'AntiCloudflareTask', 'websiteURL': page_url, 'websiteKey': site_key}, api_key)
        tid = d.get('taskId')
        if not tid:
            return None
        sol = _capsolver_poll(tid, api_key)
        return sol.get('token')
    except Exception as e:
        return None

# ─── Playwright login ─────────────────────────────────────────
async def _handle_captcha(page, cap_key, step=''):
    """Detect and solve any captcha on the current page."""
    try:
        # Collect all iframes src
        frame_urls = [f.url for f in page.frames]
        has_recaptcha = any('recaptcha' in u or 'captcha' in u for u in frame_urls)
        # Also check DOM
        if not has_recaptcha:
            try:
                has_recaptcha = await page.evaluate('''() => !!(
                    document.querySelector(".g-recaptcha,[data-sitekey],iframe[src*=recaptcha]")
                )''')
            except Exception:
                pass

        if not has_recaptcha:
            return

        print(f'[SP] [{step}] captcha detectado', flush=True)

        if not cap_key:
            print(f'[SP] sem CAPSOLVER_KEY — aguardando 20s para resolução manual...', flush=True)
            await page.wait_for_timeout(20000)
            return

        # Get sitekey
        site_key = await page.evaluate('''() => {
            var el = document.querySelector("[data-sitekey],[data-site-key]");
            if (el) return el.getAttribute("data-sitekey") || el.getAttribute("data-site-key");
            var ifrm = document.querySelector("iframe[src*=recaptcha]");
            if (ifrm) {
                var m = (ifrm.src || "").match(/k=([^&]+)/);
                if (m) return m[1];
            }
            return null;
        }''')

        if not site_key:
            print(f'[SP] [{step}] sitekey não encontrado', flush=True)
            return

        # Detect v2 vs v3
        is_v3 = await page.evaluate('''() => {
            return !!(window.grecaptcha && window.grecaptcha.execute && !document.querySelector(".g-recaptcha"));
        }''')

        print(f'[SP] [{step}] resolvendo reCAPTCHA {"v3" if is_v3 else "v2"} sitekey={site_key[:20]}', flush=True)

        token = None
        if is_v3:
            action = await page.evaluate('''() => {
                var el = document.querySelector("[data-action]");
                return el ? el.getAttribute("data-action") : "login";
            }''')
            token = _solve_recaptcha_v3(site_key, page.url, action, cap_key)
        else:
            token = _solve_recaptcha_v2(site_key, page.url, cap_key)

        if not token:
            print(f'[SP] [{step}] captcha não resolvido', flush=True)
            return

        # Inject token
        await page.evaluate('''(tok) => {
            var el = document.querySelector("#g-recaptcha-response,[name=g-recaptcha-response]");
            if (el) { el.value = tok; el.style.display = "block"; }
            try {
                if (window.___grecaptcha_cfg) {
                    var ids = Object.keys(window.___grecaptcha_cfg.clients || {});
                    if (ids.length) {
                        var cb = (window.___grecaptcha_cfg.clients[ids[0]] || {});
                        var cbKeys = Object.keys(cb);
                        for (var i = 0; i < cbKeys.length; i++) {
                            var v = cb[cbKeys[i]];
                            if (v && typeof v.callback === "function") { v.callback(tok); break; }
                        }
                    }
                }
            } catch(e) {}
        }''', token)
        print(f'[SP] [{step}] token injetado', flush=True)
        await page.wait_for_timeout(1500)
    except Exception as e:
        if 'timeout' not in str(e).lower() and 'Target' not in str(e):
            print(f'[SP] captcha handler [{step}] warn: {e}', flush=True)

async def login_via_sed_sso(ra, senha, cap_key=None, headless=True):
    """
    Login no Speaky via SSO do Sala do Futuro (RA + senha SED).
    1. SED login → sed_token
    2. EduSP registration → auth_token
    3. Rooms/cards → encontra URL do card SPeak
    4. Playwright → navega para URL SSO → auto-logado no Speaky
    5. Extrai efid_tokens → retorna {'api_token', 'bff_token'}
    """
    import cloudscraper as _cs

    # ── Normaliza RA (ex: 1090766099 → 1090766099sp) ─────────
    ra_norm = ra.strip()
    if not ra_norm.lower().endswith('sp') and not ra_norm.lower().endswith('xsp'):
        ra_norm = ra_norm + 'sp'
    ra_norm = ra_norm.lower()

    # ── Passo 1: login SED ────────────────────────────────────
    print(f'[SP] fazendo login SED para RA {ra_norm}...', flush=True)
    r1 = _req.post(SED_LOGIN_URL, json={'user': ra_norm, 'senha': senha},
                   headers=_SED_HEADERS, timeout=20)
    if r1.status_code == 401:
        try:
            msg = r1.json().get('statusRetorno', r1.text[:200])
        except Exception:
            msg = r1.text[:200]
        raise RuntimeError(f'Login SED inválido — RA ou senha incorretos: {msg}')
    r1.raise_for_status()
    d1 = r1.json()
    sed_token = d1.get('token')
    if not sed_token:
        raise RuntimeError(d1.get('statusRetorno', 'Sem token SED'))
    print('[SP] ✓ SED token OK', flush=True)

    # ── Passo 2: registro EduSP → auth_token ─────────────────
    print('[SP] registrando no edusp...', flush=True)
    sc = _cs.create_scraper()
    r2 = sc.post(
        f'{EDUSP_API_URL}/registration/edusp/token',
        json={'token': sed_token},
        headers={'Content-Type': 'application/json', 'Accept': 'application/json',
                 'x-api-realm': 'edusp', 'x-api-platform': 'webclient'},
        timeout=30
    )
    r2.raise_for_status()
    auth_token = r2.json().get('auth_token')
    if not auth_token:
        raise RuntimeError('Sem auth_token do edusp')
    print('[SP] ✓ auth_token OK', flush=True)

    # ── Passo 3: busca card do Speaky nas salas ───────────────
    print('[SP] buscando card do Speaky...', flush=True)
    r3 = sc.get(
        f'{EDUSP_API_URL}/room?with_cards=true',
        headers={'Accept': 'application/json', 'x-api-key': auth_token,
                 'x-api-realm': 'edusp', 'x-api-platform': 'webclient'},
        timeout=30
    )
    r3.raise_for_status()
    rooms = r3.json()

    speaky_sso_url = None
    for room in (rooms if isinstance(rooms, list) else []):
        for group in (room.get('group_categories') or []):
            for card in (group.get('cards') or []):
                url   = card.get('url') or ''
                label = (card.get('label') or '').lower()
                if 'ef.com' in url or 'efekta' in url or 'speak' in label:
                    speaky_sso_url = url.replace('{{seducsp_token}}', sed_token)
                    print(f'[SP] ✓ card encontrado: {card.get("label")}', flush=True)
                    break
            if speaky_sso_url:
                break
        if speaky_sso_url:
            break

    if not speaky_sso_url:
        raise RuntimeError('Card do Speaky não encontrado nas salas do aluno — aluno pode não ter acesso.')

    # ── Passo 4: Playwright → SSO URL ────────────────────────
    print('[SP] abrindo browser para SSO...', flush=True)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=headless,
            args=[
                '--no-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--lang=pt-BR,pt,en-US,en',
            ]
        )
        context = await browser.new_context(
            viewport={'width': 1366, 'height': 768},
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            locale='pt-BR',
            timezone_id='America/Sao_Paulo',
        )
        page = await context.new_page()

        if _STEALTH:
            try:
                await stealth_async(page)
            except Exception:
                pass

        print('[SP] navegando para URL SSO...', flush=True)
        await page.goto(speaky_sso_url, wait_until='load', timeout=60000)

        # Aguarda redirect SSO sair da página initiate
        try:
            await page.wait_for_url(lambda u: 'oauth2/initiate' not in u, timeout=30000)
        except Exception:
            pass

        # Aguarda app carregar (network idle)
        try:
            await page.wait_for_load_state('networkidle', timeout=30000)
        except Exception:
            pass

        await page.wait_for_timeout(2000)

        final_url = page.url
        print(f'[SP] URL final: {final_url[:120]}', flush=True)

        # ── Extrai tokens do Speaky ───────────────────────────
        all_cookies = await context.cookies()
        print(f'[SP] cookies disponíveis: {[c["name"] for c in all_cookies]}', flush=True)

        api_token = bff_token = None

        for ck in all_cookies:
            if ck['name'] == 'efid_tokens':
                try:
                    from urllib.parse import unquote
                    efid = json.loads(unquote(ck['value']))
                    api_token = efid.get('account')
                    bff_token = efid.get('access')
                    print(f'[SP] efid_tokens encontrado no cookie (domain={ck["domain"]})', flush=True)
                except Exception as e:
                    print(f'[SP] erro parse efid_tokens: {e}', flush=True)
                break

        # Fallback: document.cookie via JS (inclui cookies do domínio atual)
        if not bff_token:
            try:
                raw_cookie = await page.evaluate('''() => {
                    var c = document.cookie.split(";").find(function(s){ return s.trim().startsWith("efid_tokens="); });
                    return c ? decodeURIComponent(c.split("=").slice(1).join("=")) : null;
                }''')
                if raw_cookie:
                    efid = json.loads(raw_cookie)
                    api_token = efid.get('account') or api_token
                    bff_token = efid.get('access') or bff_token
                    print('[SP] efid_tokens via document.cookie JS', flush=True)
            except Exception:
                pass

        # Fallback: localStorage / sessionStorage
        if not bff_token:
            try:
                ls = await page.evaluate('''() => {
                    var r = {api: null, bff: null};
                    var stores = [localStorage, sessionStorage];
                    for (var si = 0; si < stores.length; si++) {
                        var s = stores[si];
                        for (var i = 0; i < s.length; i++) {
                            var k = s.key(i), v = s.getItem(k) || "";
                            if (v.length === 64 && /^[0-9a-f]{64}$/.test(v)) { r.bff = v; }
                            try {
                                var j = JSON.parse(v);
                                if (j && j.access && j.access.length === 64) { r.bff = j.access; }
                                if (j && j.account) { r.api = j.account; }
                            } catch(e) {}
                        }
                    }
                    return r;
                }''')
                if ls.get('bff') or ls.get('api'):
                    api_token = ls.get('api') or api_token
                    bff_token = ls.get('bff') or bff_token
                    print('[SP] tokens via localStorage', flush=True)
            except Exception:
                pass

        await browser.close()

    if not api_token and not bff_token:
        raise RuntimeError('SSO falhou — tokens não encontrados. Verifique RA/senha.')

    print(f'[SP] ✓ login SSO OK  api={str(api_token or "")[:16]}...', flush=True)
    return {'api_token': api_token, 'bff_token': bff_token}

# ─── API calls ────────────────────────────────────────────────
def _new_uuid():
    return str(_uuid_mod.uuid4())

def _api(method, url, api_token=None, bff_token=None, body=None):
    """HTTP call with Speaky auth headers."""
    token = api_token if url.startswith(API) else bff_token
    headers = {
        'Accept': 'application/json',
        'X-Ef-Correlation-Id': _new_uuid(),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
    }
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if body:
        headers['Content-Type'] = 'application/json'

    for attempt in range(3):
        try:
            r = _req.request(method, url, headers=headers, json=body, timeout=30)
            if r.status_code == 401 and url.startswith(BFF) and attempt == 0 and api_token:
                headers['Authorization'] = f'Bearer {api_token}'
                continue
            if not r.ok:
                raise RuntimeError(f'HTTP {r.status_code}: {r.text[:300]}')
            return r.json()
        except _req.exceptions.RequestException as e:
            if attempt == 2:
                raise RuntimeError(f'Rede: {e}')
            time.sleep(1 + attempt)

def _get_courses(at, bt):
    return _api('GET', f'{BFF}/self-study/course-groups?locale=en', api_token=at, bff_token=bt)

def _get_level_details(at, bt):
    return _api('GET', f'{BFF}/self-study/level-details?locale=en', api_token=at, bff_token=bt)

def _cmd(at, bt, lesson_id, command_type, command_data, version=0):
    return _api('POST', f'{API}/study/lesson/command', api_token=at, bff_token=bt, body={
        'commandType': command_type,
        'commandData': command_data,
        'clientState': {'lessonId': lesson_id, 'lastVersion': version}
    })

def _open_lesson_enrollment(at, bt, course_id, content_id):
    return _api('POST', f'{API}/study/progress/enrollments/{course_id}/open-lesson', api_token=at, bff_token=bt, body={
        'nodeId': content_id,
        'instructionsLocale': 'en_US',
        'publishTag': 'live'
    })

def _extract_events(data, version=0):
    evts = (data.get('eventHistory') or {}).get('events') or []
    out = {
        'max_v': version, 'task_done': False, 'lesson_passed': False,
        'new_acts': [], 'session_id': None, 'lesson_id': None,
    }
    for e in evts:
        v = e.get('version', 0)
        if v > out['max_v']:
            out['max_v'] = v
        t = e.get('type', '')
        if t in ('task-completed', 'task-passed'):
            out['task_done'] = True
        if t in ('lesson-passed', 'lesson-completed', 'level-passed', 'lesson-finished'):
            out['lesson_passed'] = True
        if t == 'lesson-started':
            ls = (e.get('data') or {}).get('lessonStarted') or {}
            if ls.get('sessionId'):
                out['session_id'] = ls['sessionId']
            if ls.get('lessonId'):
                out['lesson_id'] = ls['lessonId']
            acts = ls.get('activities') or []
            if ls.get('activity'):
                acts = [ls['activity']]
            out['new_acts'].extend(acts)
        if t == 'activity-sent':
            act = ((e.get('data') or {}).get('activitySent') or {}).get('activity') or {}
            if act:
                out['new_acts'].append(act)
    return out

def _process_task(at, bt, lesson_id, act_id, sess_id, task, version, log_fn):
    """Submit or skip one task. Returns (new_version, lesson_passed, new_activities)."""
    tid = task.get('id') or task.get('taskId') or ''
    er = task.get('expectedResponse') or {}
    tt = (er.get('type') or task.get('type') or task.get('taskType') or '').lower()

    # Audio/speaking types → skip
    ts = json.dumps(task)
    is_audio = (
        tt in ('speaking-practice', 'ai-roleplay-fluency', 'speaking', 'pronunciation')
        or '"speakingPractice"' in ts
        or '"aiRoleplayFluency"' in ts
        or '"pronunciation"' in ts
    )
    if is_audio:
        log_fn(f'  skip áudio ({tt})')
        try:
            r = _cmd(at, bt, lesson_id, 'skip-task', {'skipTask': {
                'lessonId': lesson_id, 'activityId': act_id, 'sessionId': sess_id, 'taskId': tid
            }}, version)
            ev = _extract_events(r, version)
            return ev['max_v'], ev['lesson_passed'], ev['new_acts']
        except Exception as e:
            log_fn(f'  skip err: {e}')
            return version, False, []

    # No expectedResponse → map by type
    if not er or not er.get('contents'):
        camel = re.sub(r'-([a-z])', lambda m: m.group(1).upper(), tt)
        simple = {
            'flash-card': {camel: {'userInput': {'seen': True, 'correct': True}}},
            'flashcard':  {'flashCard': {'userInput': {'seen': True, 'correct': True}}},
            'flashCard':  {'flashCard': {'userInput': {'seen': True, 'correct': True}}},
            'video':      {'video': {'userInput': {'watched': True}}},
            'watch-video':{'watchVideo': {'userInput': {'watched': True}}},
            'listenVideo':{'listenVideo': {'userInput': {'watched': True}}},
        }.get(tt)

        if not simple:
            log_fn(f'  skip desconhecido ({tt})')
            try:
                r = _cmd(at, bt, lesson_id, 'skip-task', {'skipTask': {
                    'lessonId': lesson_id, 'activityId': act_id, 'sessionId': sess_id, 'taskId': tid
                }}, version)
                ev = _extract_events(r, version)
                return ev['max_v'], ev['lesson_passed'], ev['new_acts']
            except Exception:
                return version, False, []

        try:
            r = _cmd(at, bt, lesson_id, 'submit-task-response', {'submitTaskResponse': {
                'lessonId': lesson_id, 'activityId': act_id, 'sessionId': sess_id,
                'response': {'taskId': tid, 'type': tt, 'contents': simple},
                'timeSpentSecs': random.randint(2, 7)
            }}, version)
            ev = _extract_events(r, version)
            return ev['max_v'], ev['lesson_passed'], ev['new_acts']
        except Exception as e:
            log_fn(f'  submit simples err: {e}')
            return version, False, []

    # Normal task with expectedResponse
    try:
        r = _cmd(at, bt, lesson_id, 'submit-task-response', {'submitTaskResponse': {
            'lessonId': lesson_id, 'activityId': act_id, 'sessionId': sess_id,
            'response': {'taskId': er.get('taskId', tid), 'type': er.get('type', tt), 'contents': json.loads(json.dumps(er['contents']))},
            'timeSpentSecs': random.randint(3, 11)
        }}, version)
        ev = _extract_events(r, version)
        return ev['max_v'], ev['lesson_passed'], ev['new_acts']
    except Exception as e:
        log_fn(f'  submit err: {str(e)[:80]} → skip')
        try:
            r = _cmd(at, bt, lesson_id, 'skip-task', {'skipTask': {
                'lessonId': lesson_id, 'activityId': act_id, 'sessionId': sess_id, 'taskId': tid
            }}, version)
            ev = _extract_events(r, version)
            return ev['max_v'], ev['lesson_passed'], ev['new_acts']
        except Exception:
            return version, False, []

# ─── Main lesson runner ───────────────────────────────────────
def run_all_lessons(api_token, bff_token, log_fn=None):
    """Complete all pending lessons. Returns stats dict."""
    if log_fn is None:
        log_fn = lambda m: print(f'[SP] {m}', flush=True)

    stats = {'lessons_done': 0, 'tasks_done': 0, 'skipped': 0, 'errors': 0}
    at, bt = api_token, bff_token

    # ── Busca cursos ──────────────────────────────────────────
    log_fn('buscando cursos...')
    try:
        cg = _get_courses(at, bt)
        courses = []
        if isinstance(cg, list):
            for g in cg:
                if isinstance(g, dict):
                    courses.extend(g.get('courses') or [])
        elif isinstance(cg, dict):
            courses = cg.get('courses') or []
    except Exception as e:
        log_fn(f'erro cursos: {e}')
        return stats

    if not courses:
        log_fn('nenhum curso encontrado')
        return stats
    log_fn(f'{len(courses)} curso(s)')

    # ── Busca lições ──────────────────────────────────────────
    log_fn('buscando lições...')
    lessons = []
    try:
        ld = _get_level_details(at, bt)
        def _flatten_lessons(obj):
            if isinstance(obj, list):
                for item in obj:
                    _flatten_lessons(item)
            elif isinstance(obj, dict):
                if 'id' in obj and ('taskCount' in obj or 'status' in obj or 'contentId' in obj):
                    lessons.append(obj)
                for v in obj.values():
                    if isinstance(v, (list, dict)):
                        _flatten_lessons(v)
        _flatten_lessons(ld)
    except Exception as e:
        log_fn(f'erro lições: {e}')

    log_fn(f'{len(lessons)} lição(ões) para processar')

    # ── Processa cada lição ────────────────────────────────────
    for lesson in lessons:
        if not isinstance(lesson, dict):
            continue
        status = (lesson.get('status') or lesson.get('progress') or '').lower()
        if status in ('completed', 'passed', 'done', 'finished'):
            continue

        content_id = lesson.get('contentId') or lesson.get('id') or lesson.get('lessonId') or ''
        course_id = lesson.get('courseId') or (courses[0].get('id') if courses else '')
        title = lesson.get('title') or lesson.get('name') or content_id[:12]
        log_fn(f'lição: {title}')

        try:
            time.sleep(0.8)
            # Open enrollment
            lesson_id = None
            try:
                enroll = _open_lesson_enrollment(at, bt, course_id, content_id)
                lesson_id = (enroll or {}).get('lessonId') or (enroll or {}).get('id')
            except Exception:
                pass
            if not lesson_id:
                lesson_id = content_id

            # Open-lesson command
            try:
                cmd_r = _cmd(at, bt, lesson_id, 'open-lesson', {
                    'openLesson': {'lessonId': lesson_id, 'instructionsLocale': 'en_US'}
                }, 0)
                ev = _extract_events(cmd_r)
                if ev['lesson_id']:
                    lesson_id = ev['lesson_id']
                activities = ev['new_acts']
                session_id = ev['session_id'] or ''
                version = ev['max_v']
                if ev['lesson_passed']:
                    log_fn('  ✓ já concluída')
                    stats['lessons_done'] += 1
                    continue
            except Exception as e:
                log_fn(f'  open-lesson err: {e}')
                stats['errors'] += 1
                continue

            # Fila de atividades
            iterations = 0
            while activities and iterations < 60:
                iterations += 1
                act = activities.pop(0)
                act_id = act.get('id') or act.get('activityId') or ''
                for task in (act.get('tasks') or []):
                    v, lp, new_acts = _process_task(at, bt, lesson_id, act_id, session_id, task, version, log_fn)
                    version = v
                    stats['tasks_done'] += 1
                    activities.extend(new_acts)
                    if lp:
                        log_fn('  ✓ lição concluída!')
                        stats['lessons_done'] += 1
                        activities = []
                        break
                    time.sleep(0.4)

        except Exception as e:
            log_fn(f'  erro: {str(e)[:120]}')
            stats['errors'] += 1

    log_fn(f'fim! lições={stats["lessons_done"]} tasks={stats["tasks_done"]} erros={stats["errors"]}')
    return stats

# ─── Job entry point (called by hub_proxy background thread) ──
def run_job(ra, senha, cap_key=None, on_log=None, on_done=None):
    """Blocking. Runs SED SSO login + all lessons for one account."""
    def _l(msg):
        print(f'[SP] {msg}', flush=True)
        if on_log:
            on_log(msg)

    try:
        _l(f'iniciando para RA {ra}...')
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        tokens = loop.run_until_complete(
            login_via_sed_sso(ra, senha, cap_key or CAPSOLVER_KEY)
        )
        loop.close()
        _l('login OK — iniciando lições...')
        stats = run_all_lessons(tokens['api_token'], tokens['bff_token'], _l)
        result = {'ok': True, **stats}
    except Exception as e:
        result = {'ok': False, 'error': str(e)}
        _l(f'ERRO: {e}')

    if on_done:
        on_done(result)
    return result

# ─── CLI ──────────────────────────────────────────────────────
if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Uso: python speaky_run.py <ra> <senha> [capsolver_key]')
        print('   CAPSOLVER_KEY=xxx python speaky_run.py ra senha')
        sys.exit(1)
    _ra   = sys.argv[1]
    _pass = sys.argv[2]
    _cap  = sys.argv[3] if len(sys.argv) > 3 else os.environ.get('CAPSOLVER_KEY', '')
    result = run_job(_ra, _pass, _cap, on_log=print)
    print(json.dumps(result, indent=2, ensure_ascii=False))
