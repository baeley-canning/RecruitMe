# RecruitMe Opera LinkedIn Capture

Load this folder as an unpacked extension in Opera or any Chromium-based browser.

## Install

1. Open `opera://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder:

```text
browser-companion/recruitme-opera-linkedin-capture
```

## Usage

- In RecruitMe, click **Fetch profile** on a candidate card.
- RecruitMe creates a pending capture session and opens LinkedIn.
- This extension detects the pending session, captures the rendered LinkedIn profile, and posts it back to RecruitMe automatically.

The popup also supports manual imports:

- Open a LinkedIn profile
- Click the extension icon
- Choose a job
- Click **Import current LinkedIn profile**

## If RecruitMe uses a login prompt

RecruitMe currently uses HTTP Basic auth when `ADMIN_USER` / `ADMIN_PASS` are set. Browser extensions do not inherit that login automatically.

- Open the extension popup
- Enter the same RecruitMe server URL
- Enter the same username and password you use in the browser
- Click **Save connection**
