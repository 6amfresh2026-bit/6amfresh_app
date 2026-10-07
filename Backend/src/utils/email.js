import nodemailer from 'nodemailer';
import { config } from '../config/env.js';
import { logger } from './logger.js';

let transporter = null;

function getTransporter() {
    if (transporter) return transporter;
    const { emailHost, emailPort, emailUser, emailPass } = config;
    if (!emailHost || !emailUser || !emailPass) {
        logger.warn('Email not configured: EMAIL_HOST, EMAIL_USER, EMAIL_PASS required');
        return null;
    }
    transporter = nodemailer.createTransport({
        host: emailHost,
        port: emailPort || 587,
        secure: emailPort === 465,
        auth: {
            user: emailUser,
            pass: emailPass
        }
    });
    return transporter;
}

/**
 * Send OTP email for admin forgot password.
 * @param {string} to - Recipient email
 * @param {string} otp - 6-digit OTP
 * @returns {Promise<boolean>} true if sent, false if skipped/failed
 */
export async function sendAdminResetOtpEmail(to, otp) {
    const trans = getTransporter();
    if (!trans) {
        logger.warn('Admin OTP email skipped: SMTP not configured');
        return false;
    }
    const from = config.emailFrom || config.emailUser;
    const subject = 'Your password reset code – 6AM Fresh Admin';
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 480px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #111;">Password reset code</h2>
  <p>Use the code below to reset your admin password. It is valid for 10 minutes.</p>
  <p style="font-size: 24px; font-weight: bold; letter-spacing: 4px; background: #f5f5f5; padding: 12px 16px; border-radius: 8px;">${otp}</p>
  <p style="color: #666; font-size: 14px;">If you did not request this, you can ignore this email.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
  <p style="color: #999; font-size: 12px;">6AM Fresh Admin</p>
</body>
</html>`;
    const text = `Your password reset code is: ${otp}. It is valid for 10 minutes. If you did not request this, ignore this email.`;

    try {
        await trans.sendMail({
            from: typeof from === 'string' && from.includes('<') ? from : `6AM Fresh <${from}>`,
            to,
            subject,
            text,
            html
        });
        logger.info(`Admin reset OTP email sent to ${to}`);
        return true;
    } catch (err) {
        logger.error(`Failed to send admin OTP email to ${to}:`, err.message);
        return false;
    }
}

/**
 * Low-level helper: send a plain HTML email to the configured recipient(s).
 * Returns true if sent, false if SMTP is not configured or sending failed, so
 * callers can fire-and-forget without ever breaking the request they ran in.
 * @param {Object} opts
 * @param {string|string[]} opts.to - recipient(s); defaults handled by caller
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {string} [opts.text]
 */
export async function sendEmail({ to, subject, html, text }) {
    const trans = getTransporter();
    if (!trans) {
        logger.warn('Email skipped: SMTP not configured');
        return false;
    }
    const recipients = Array.isArray(to) ? to.filter(Boolean).join(',') : to;
    if (!recipients) {
        logger.warn('Email skipped: no recipient');
        return false;
    }
    const from = config.emailFrom || config.emailUser;
    try {
        await trans.sendMail({
            from: typeof from === 'string' && from.includes('<') ? from : `6AM Fresh <${from}>`,
            to: recipients,
            subject,
            html,
            text: text || String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        });
        logger.info(`Email "${subject}" sent to ${recipients}`);
        return true;
    } catch (err) {
        logger.error(`Failed to send email "${subject}" to ${recipients}:`, err.message);
        return false;
    }
}

const money = (n) => `Rs. ${(Number(n) || 0).toLocaleString('en-IN')}`;

/**
 * Who a low-stock alert goes to: the central alert inbox(es) from
 * STOCK_ALERT_EMAIL (comma-separated) plus the owning seller when known.
 * Pure and dedup-free by design — exported so tests can assert recipient
 * resolution without touching SMTP.
 * @param {string} [sellerEmail]
 * @returns {string[]}
 */
export function resolveStockAlertRecipients(sellerEmail = '') {
    return [
        ...String(config.stockAlertEmail || '').split(',').map((s) => s.trim()),
        sellerEmail
    ].filter(Boolean);
}

/**
 * Build the low-stock alert email. Pure: given the same product fields it
 * always returns the same { subject, html, text, isOut }. No I/O, so CI can
 * assert its content without any SMTP configured.
 * @param {Object} p - see sendLowStockAlertEmail
 */
export function buildLowStockAlertEmail(p = {}) {
    const {
        productName = 'Product',
        currentStock = 0,
        threshold = 0,
        sku = '',
        unit = '',
        sellerName = '',
        price
    } = p;

    const isOut = Number(currentStock) <= 0;
    const badge = isOut ? '#dc2626' : '#d97706';
    const badgeText = isOut ? 'OUT OF STOCK' : 'LOW STOCK';
    const qty = `${currentStock}${unit ? ' ' + unit : ''}`;

    const subject = `${isOut ? '⛔ Out of stock' : '⚠️ Low stock'}: ${productName}${sellerName ? ' · ' + sellerName : ''}`;
    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 520px; margin: 0 auto; padding: 20px;">
  <div style="background:#0f766e;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;">
    <h2 style="margin:0;font-size:18px;">6AM Fresh — Inventory Alert</h2>
  </div>
  <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:20px;">
    <span style="display:inline-block;background:${badge};color:#fff;font-size:12px;font-weight:bold;padding:3px 10px;border-radius:999px;letter-spacing:.5px;">${badgeText}</span>
    <h3 style="margin:14px 0 6px;font-size:17px;">${productName}</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 0;color:#64748b;">Current stock</td><td style="padding:6px 0;text-align:right;font-weight:bold;color:${badge};">${qty}</td></tr>
      <tr><td style="padding:6px 0;color:#64748b;">Low-stock threshold</td><td style="padding:6px 0;text-align:right;">${threshold}${unit ? ' ' + unit : ''}</td></tr>
      ${sku ? `<tr><td style="padding:6px 0;color:#64748b;">SKU</td><td style="padding:6px 0;text-align:right;">${sku}</td></tr>` : ''}
      ${sellerName ? `<tr><td style="padding:6px 0;color:#64748b;">Seller</td><td style="padding:6px 0;text-align:right;">${sellerName}</td></tr>` : ''}
      ${price != null ? `<tr><td style="padding:6px 0;color:#64748b;">Price</td><td style="padding:6px 0;text-align:right;">${money(price)}</td></tr>` : ''}
    </table>
    <p style="margin:16px 0 0;color:#475569;font-size:14px;">
      ${isOut ? 'This item is out of stock and no longer orderable. Please restock it as soon as possible.'
              : 'This item has fallen to or below its low-stock threshold. Please restock it soon to avoid going out of stock.'}
    </p>
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
    <p style="color:#94a3b8;font-size:12px;margin:0;">Automated inventory alert · 6AM Fresh</p>
  </div>
</body></html>`;

    return { subject, html, isOut, recipients: resolveStockAlertRecipients(p.sellerEmail) };
}

/**
 * Low-stock alert email. Sent to the central alert inbox (STOCK_ALERT_EMAIL)
 * and, when available, the seller who owns the product. Fire-and-forget.
 * @param {Object} p
 * @param {string} p.productName
 * @param {number} p.currentStock
 * @param {number} p.threshold
 * @param {string} [p.sku]
 * @param {string} [p.unit]
 * @param {string} [p.sellerName]
 * @param {string} [p.sellerEmail]  - also notified when present
 * @param {number} [p.price]
 */
export async function sendLowStockAlertEmail(p = {}) {
    const { subject, html, recipients } = buildLowStockAlertEmail(p);
    if (recipients.length === 0) {
        logger.warn('Low-stock alert skipped: no recipient configured (STOCK_ALERT_EMAIL)');
        return false;
    }
    return sendEmail({ to: recipients, subject, html });
}
