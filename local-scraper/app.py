"""
Local LinkedIn scraper — runs on your laptop, talks to RecruitMe via ngrok.

Why local: Railway's IPs are blacklisted by LinkedIn (HTTP 999). Your home
IP is residential and trusted. Same scraper logic, different IP.

Flow:
  RecruitMe app  --(POST /scrape-async via ngrok)-->  this service
        ^                                                    |
        |                                                    | runs joeyism/
        |                                                    | linkedin_scraper
        +--POST /api/extension/fetch-session/complete <------+

Auth between the app and this service is X-Scraper-Api-Key (must match
SCRAPER_API_KEY in Railway). The /complete callback uses the unguessable
sessionId for auth, no extra header needed.
"""

import os
import queue
import threading
import time
import traceback

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from linkedin_scraper import Person, actions
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

load_dotenv()  # populate os.environ from a .env in this dir, if present


API_KEY = os.environ.get("SCRAPER_API_KEY", "").strip()
LI_AT = os.environ.get("LINKEDIN_LI_AT", "").strip()
LINKEDIN_EMAIL = os.environ.get("LINKEDIN_EMAIL", "").strip()
LINKEDIN_PASSWORD = os.environ.get("LINKEDIN_PASSWORD", "").strip()
PORT = int(os.environ.get("PORT", "8080"))
HEADLESS = os.environ.get("HEADLESS", "false").lower() in ("1", "true", "yes")

if not API_KEY:
    print("[scraper-py] WARNING: SCRAPER_API_KEY is empty — all requests will be rejected")

app = Flask(__name__)
job_queue: "queue.Queue[dict]" = queue.Queue()
driver = None
driver_lock = threading.Lock()


def init_driver() -> None:
    """Boot Chrome, sign in via cookie or credentials. Visible by default
    so LinkedIn sees a normal browser, not a headless fingerprint."""
    global driver
    options = Options()
    if HEADLESS:
        options.add_argument("--headless=new")
    # Strip telltale automation signals.
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)
    options.add_argument("--window-size=1280,900")
    # Use a persistent profile dir so the cookie sticks across restarts and
    # LinkedIn doesn't see a brand-new session every time you reboot.
    profile_dir = os.path.join(os.path.dirname(__file__), ".chrome-profile")
    options.add_argument(f"--user-data-dir={profile_dir}")

    driver = webdriver.Chrome(options=options)
    driver.execute_cdp_cmd(
        "Page.addScriptToEvaluateOnNewDocument",
        {"source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"},
    )

    if LI_AT:
        driver.get("https://www.linkedin.com")
        try:
            driver.delete_cookie("li_at")
        except Exception:
            pass
        driver.add_cookie({
            "name": "li_at",
            "value": LI_AT,
            "domain": ".linkedin.com",
            "path": "/",
            "secure": True,
            "httpOnly": True,
        })
        driver.get("https://www.linkedin.com/feed/")
        time.sleep(2)
        if "/login" in driver.current_url or "/authwall" in driver.current_url:
            raise RuntimeError(f"LI_AT cookie rejected — landed on {driver.current_url}. Refresh the cookie.")
        print("[scraper-py] signed in via LI_AT cookie")
    elif LINKEDIN_EMAIL and LINKEDIN_PASSWORD:
        actions.login(driver, LINKEDIN_EMAIL, LINKEDIN_PASSWORD)
        print("[scraper-py] signed in via email/password")
    else:
        raise RuntimeError("Set LINKEDIN_LI_AT (preferred) or LINKEDIN_EMAIL+LINKEDIN_PASSWORD")


def format_profile(person: Person) -> str:
    """Convert the joeyism Person object into the same shape the app's
    scoring pipeline already consumes (plain text, sectioned)."""
    out: list[str] = []
    if person.name:
        out.append(f"Name: {person.name}")
    if person.job_title:
        out.append(f"Headline: {person.job_title}")
    if person.location:
        out.append(f"Location: {person.location}")
    if person.about:
        out.append(f"\nAbout\n{person.about}")

    if person.experiences:
        out.append("\nExperience")
        for e in person.experiences:
            line = f"- {e.position_title or ''} at {e.institution_name or ''}".strip()
            dates = " – ".join(filter(None, [e.from_date, e.to_date]))
            if dates:
                line += f" ({dates})"
            out.append(line)
            if e.location:
                out.append(f"  Location: {e.location}")
            if e.description:
                out.append(f"  {e.description}")

    if person.educations:
        out.append("\nEducation")
        for ed in person.educations:
            line = f"- {ed.institution_name or ''}".strip()
            if ed.degree:
                line += f", {ed.degree}"
            dates = " – ".join(filter(None, [ed.from_date, ed.to_date]))
            if dates:
                line += f" ({dates})"
            out.append(line)
            if ed.description:
                out.append(f"  {ed.description}")

    if person.interests:
        out.append("\nInterests")
        for i in person.interests:
            out.append(f"- {getattr(i, 'title', str(i))}")

    if person.accomplishments:
        out.append("\nAccomplishments")
        for a in person.accomplishments:
            out.append(f"- {getattr(a, 'category', '')}: {getattr(a, 'title', str(a))}")

    return "\n".join(out).strip()


def post_complete(job: dict, profile_text: str) -> None:
    callback = job["callbackUrl"].rstrip("/")
    res = requests.post(
        f"{callback}/api/extension/fetch-session/complete",
        json={
            "sessionId":   job["sessionId"],
            "linkedinUrl": job["linkedinUrl"],
            "profileText": profile_text,
        },
        timeout=30,
    )
    if not res.ok:
        print(f"[scraper-py] /complete returned {res.status_code}: {res.text[:200]}")


def post_error(job: dict, error: str) -> None:
    try:
        callback = job["callbackUrl"].rstrip("/")
        requests.post(
            f"{callback}/api/extension/fetch-session/error",
            json={"sessionId": job["sessionId"], "error": error},
            timeout=15,
        )
    except Exception as err:
        print(f"[scraper-py] error callback threw: {err}")


def worker() -> None:
    while True:
        job = job_queue.get()
        sid = job.get("sessionId", "?")
        url = job.get("linkedinUrl", "?")
        start = time.time()
        try:
            print(f"[scraper-py] starting {sid} for {url}")
            with driver_lock:
                # close_on_complete=False keeps the Chrome session warm for the
                # next job — booting Chrome is the single slowest step.
                person = Person(url, driver=driver, scrape=True, close_on_complete=False)
                profile_text = format_profile(person)
            elapsed = round(time.time() - start)
            if len(profile_text) < 200:
                raise RuntimeError(f"Profile text too short ({len(profile_text)} chars) — may be private or session expired")
            print(f"[scraper-py] {sid} done in {elapsed}s — {len(profile_text)} chars")
            post_complete(job, profile_text)
        except Exception as err:
            elapsed = round(time.time() - start)
            tb = traceback.format_exc()
            print(f"[scraper-py] {sid} failed in {elapsed}s: {err}\n{tb}")
            post_error(job, str(err))
        finally:
            job_queue.task_done()


# ── HTTP API ──────────────────────────────────────────────────────────────

def require_api_key() -> bool:
    return request.headers.get("X-Scraper-Api-Key", "") == API_KEY and API_KEY != ""


@app.route("/health")
def health():
    return jsonify({"ok": True, "version": "0.1.0", "queue_size": job_queue.qsize()})


@app.route("/scrape-async", methods=["POST"])
def scrape_async():
    if not require_api_key():
        return jsonify({"error": "Unauthorized"}), 401
    body = request.get_json(silent=True) or {}
    for k in ("linkedinUrl", "sessionId", "callbackUrl"):
        if not body.get(k):
            return jsonify({"error": f"{k} is required"}), 400
    if "linkedin.com/in/" not in body["linkedinUrl"]:
        return jsonify({"error": "linkedinUrl must contain linkedin.com/in/"}), 400
    job_queue.put(body)
    return jsonify({"queued": True, "queueSize": job_queue.qsize()}), 202


if __name__ == "__main__":
    init_driver()
    threading.Thread(target=worker, daemon=True).start()
    print(f"[scraper-py] listening on port {PORT}")
    app.run(host="0.0.0.0", port=PORT, threaded=True)
