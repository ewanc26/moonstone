import nodemailer from 'nodemailer'
import { logger } from './logger.js'

export class Mailer {
  private transporter: nodemailer.Transporter

  constructor(
    private smtpUrl: string,
    private fromAddress: string,
    private hostname: string,
  ) {
    this.transporter = nodemailer.createTransport(smtpUrl)
  }

  private async send(opts: { to: string; subject: string; text: string }) {
    try {
      await this.transporter.sendMail({
        from: this.fromAddress,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
      })
    } catch (err) {
      logger.error({ err }, 'failed to send email')
    }
  }

  sendConfirmEmail(data: { token: string }, opts: { to: string }) {
    return this.send({
      to: opts.to,
      subject: `Confirm your ${this.hostname} account`,
      text: `Your email confirmation token is: ${data.token}\n\nThis token expires in 15 minutes.`,
    })
  }

  sendUpdateEmail(data: { token: string }, opts: { to: string }) {
    return this.send({
      to: opts.to,
      subject: `Update your ${this.hostname} email`,
      text: `Your email update token is: ${data.token}\n\nThis token expires in 15 minutes.`,
    })
  }

  sendResetPassword(data: { handle: string; token: string }, opts: { to: string }) {
    return this.send({
      to: opts.to,
      subject: `Reset your ${this.hostname} password`,
      text: `Hi ${data.handle},\n\nYour password reset token is: ${data.token}\n\nThis token expires in 15 minutes.`,
    })
  }

  sendAccountDelete(data: { token: string }, opts: { to: string }) {
    return this.send({
      to: opts.to,
      subject: `Delete your ${this.hostname} account`,
      text: `Your account deletion token is: ${data.token}\n\nThis token expires in 15 minutes.`,
    })
  }

  sendPlcOperation(data: { token: string }, opts: { to: string }) {
    return this.send({
      to: opts.to,
      subject: `Authorize PLC operation for your ${this.hostname} account`,
      text: `Your PLC operation authorization token is: ${data.token}\n\nThis token expires in 15 minutes.`,
    })
  }

  sendAdminEmail(data: { subject: string; content: string }, opts: { to: string }) {
    return this.send({
      to: opts.to,
      subject: data.subject,
      text: data.content,
    })
  }
}
