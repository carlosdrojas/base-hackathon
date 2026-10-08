export function renderLoginPage(error: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Log in — ARCA</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap">
<style>
  body { margin: 0; background: #F0EEEB; font-family: 'Space Grotesk', system-ui, sans-serif; color: #292826; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  a { color: #1E4D2B; }
</style>
</head>
<body>
  <div style="width: 340px; background: #FFFFFF; border: 1px solid #DEDAD2; border-radius: 8px; padding: 32px;">
    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 24px;">
      <img src="/base_logo.png" alt="Base" style="height: 40px; width: auto; display: block;">
      <span style="width: 1px; height: 22px; background: #C9C6BD; display: inline-block;"></span>
      <span style="font-size: 15px; color: #6B6A64;">ARCA &mdash; Automatic Root Cause Analysis</span>
    </div>
    <div style="font-size: 20px; font-weight: 600; margin-bottom: 4px;">Log in</div>
    <div style="font-size: 14px; color: #6B6A64; margin-bottom: 20px;">Demo accounts</div>
    ${error ? `<div style="background: #FDECEC; color: #B42318; font-size: 14px; padding: 10px 12px; border-radius: 6px; margin-bottom: 16px;">Incorrect username or password.</div>` : ""}
    <form method="POST" action="/login">
      <label style="display: block; font-size: 13px; font-weight: 600; color: #6B6A64; margin-bottom: 4px;">Username</label>
      <input name="username" type="text" autocomplete="username" style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #D8D5CC; border-radius: 6px; font-size: 15px; font-family: inherit; margin-bottom: 14px;">
      <label style="display: block; font-size: 13px; font-weight: 600; color: #6B6A64; margin-bottom: 4px;">Password</label>
      <input name="password" type="password" autocomplete="current-password" style="width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #D8D5CC; border-radius: 6px; font-size: 15px; font-family: inherit; margin-bottom: 20px;">
      <button type="submit" style="width: 100%; background: #1E4D2B; color: #FFFFFF; border: none; border-radius: 6px; padding: 12px 0; font-size: 15px; font-weight: 700; cursor: pointer;">Log in</button>
    </form>
    <div style="font-size: 13px; color: #6B6A64; margin: 20px 0 8px;">Or jump straight in:</div>
    <div style="display: flex; gap: 8px;">
      ${demoButton("staffAustin", "Ops staff view")}
      ${demoButton("tech", "Technician view")}
    </div>
    <div style="font-size: 12px; color: #8A877F; line-height: 1.5; margin-top: 20px; padding-top: 16px; border-top: 1px solid #ECE9E2;">
      Hackathon project from the Base Power &times; AITX Talent Hackathon (Sep 2026). Not a Base product. All fleet data is synthetic.
    </div>
  </div>
</body>
</html>`;
}

// One-click demo login: posts the public demo credentials so visitors skip typing.
function demoButton(username: string, label: string): string {
  return `<form method="POST" action="/login" style="flex: 1; margin: 0;">
        <input type="hidden" name="username" value="${username}">
        <input type="hidden" name="password" value="basehq2026">
        <button type="submit" style="width: 100%; background: #FFFFFF; color: #1E4D2B; border: 1px solid #1E4D2B; border-radius: 6px; padding: 10px 0; font-size: 14px; font-weight: 600; font-family: inherit; cursor: pointer;">${label}</button>
      </form>`;
}
