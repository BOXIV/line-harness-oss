// BOXIV-only: 出品フォーム未連携者へのフォローアップ催促メール（HTML）。
// 追加ドライバー申請メールと同一デザイン（白背景 / #f5f5f7 カード / 黒系UI / LINEグリーンCTA）。
// ロゴは prod R2 配信(/images/...)を参照（添付不要・test/prod共通の公開URL）。

const LOGO_URL = 'https://line-connect.boxiv.workers.dev/images/lightning-logo-email.png';
const SUPPORT_FORM_URL = 'https://lightning.boxiv.co.jp/support';

export interface ReminderEmailContent {
  subject: string;
  text: string;
  html: string;
}

/**
 * 催促メールを生成。link = LIFF ラップ済みの連携リンク（呼び出し側で生成）。
 */
export function buildReminderEmail(link: string): ReminderEmailContent {
  const subject = '【BOXIV Lightning】LINE連携のお願い';
  const html = `<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BOXIV Lightning LINE連携のご案内</title></head>
<body style="margin:0;padding:0;background-color:#ffffff;font-family:-apple-system,'Hiragino Sans','Helvetica Neue',Arial,sans-serif;color:#1d1d1f;line-height:1.7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff">
    <tr><td align="center" style="padding:32px 16px">
      <div style="text-align:center;margin:0 0 24px 0">
        <img src="${LOGO_URL}" alt="BOXIV Lightning" width="300" style="display:inline-block;width:50%;max-width:300px;height:auto;">
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#f5f5f7;border-radius:14px">
        <tr><td style="padding:45px 44px 0 44px">
          <p style="margin:0 0 12px 0;font-size:15px">この度はBOXIV Lightningへのご出品手続きをいただき誠にありがとうございます。</p>
          <p style="margin:0 0 12px 0;font-size:15px">BOXIV Lightning サポートチームでございます。</p>
          <p style="margin:0;font-size:15px">出品フォームのご入力を承りました。お車の成約まではLINEにてやり取りさせていただきますため、お手数ではございますが公式LINEアカウントとの連携をお願いいたします。</p>
        </td></tr>
        <tr><td style="padding:28px 44px 0 44px">
          <h2 style="margin:0 0 8px 0;font-size:18px;font-weight:700;color:#1d1d1f">LINE連携のお手続き</h2>
          <hr style="border:0;border-top:1px solid #d2d2d7;margin:0 0 16px 0">
          <p style="margin:0 0 8px 0;font-size:15px">下記リンクから公式LINEアカウントとの連携をお願いいたします。</p>
          <p style="margin:0 0 16px 0;font-size:13px;color:#6e6e73">※スマートフォンではLINEアプリが起動し、自動でログインされます。</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px 0">
            <tr><td style="background-color:#06c755;border-radius:9999px"><a href="${link}" style="display:inline-block;padding:14px 32px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;border-radius:9999px">LINEで連携する</a></td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:28px 44px 0 44px">
          <p style="margin:0;font-size:15px">LINE連携後に撮影日程調整のご連絡を差し上げますので、早めのご対応をお願いいたします。</p>
        </td></tr>
        <tr><td style="padding:16px 44px 16px 44px">
          <p style="margin:0;font-size:15px">今後ともBOXIV Lightningをどうぞよろしくお願いいたします。</p>
        </td></tr>
        <tr><td style="padding:8px 44px 45px 44px">
          <hr style="border:0;border-top:1px solid #d2d2d7;margin:0 0 16px 0">
          <p style="margin:0 0 4px 0;font-size:14px;font-weight:600;color:#1d1d1f">BOXIV Lightning サポートチーム</p>
          <p style="margin:0 0 8px 0;font-size:13px;color:#6e6e73">※このメールは送信専用です。ご返信いただいても当社では受信できません。</p>
          <p style="margin:0;font-size:13px;color:#6e6e73">お問い合わせフォームは<a href="${SUPPORT_FORM_URL}" style="color:#06c755;text-decoration:underline;font-weight:600">こちら</a></p>
        </td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:24px;line-height:24px">&nbsp;</td></tr></table>
    </td></tr>
  </table>
</body></html>`;

  const text = `この度はBOXIV Lightningへのご出品手続きをいただき誠にありがとうございます。
BOXIV Lightning サポートチームでございます。

出品フォームのご入力を承りました。お車の成約まではLINEにてやり取りさせていただきますため、
お手数ではございますが公式LINEアカウントとの連携をお願いいたします。

■ LINE連携のお手続き
下記リンクから連携をお願いいたします（スマートフォンではLINEアプリが起動し自動ログインされます）。
${link}

LINE連携後に撮影日程調整のご連絡を差し上げますので、早めのご対応をお願いいたします。
今後ともBOXIV Lightningをどうぞよろしくお願いいたします。

BOXIV Lightning サポートチーム
※このメールは送信専用です。ご返信いただいても当社では受信できません。
お問い合わせフォーム: ${SUPPORT_FORM_URL}`;

  return { subject, text, html };
}

/** SMS 本文（プレーン・実改行・短縮リンク）。link は短縮URL(/r/<key>)を渡す想定。 */
export function buildReminderSms(link: string): string {
  return [
    '【BOXIV Lightning】',
    '出品フォームのご入力ありがとうございます。お車の成約までLINEでやり取りいたしますので、公式LINEの連携をお願いします。',
    '',
    '▼連携はこちら',
    link,
  ].join('\n');
}
