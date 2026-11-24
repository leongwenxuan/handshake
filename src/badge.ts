import type { Card } from './api'

// The verdict as a picture for the glasses' image container: a ring that
// fills with the score and the number in the middle, readable at a glance.
// White is bright green on the display; black is off.

export const BADGE_SIZE = 84

function glyph(card: Card): { text: string; fill: number | null } {
  if (card.relation === 'competitor') return { text: 'VS', fill: null }
  if (card.relation === 'colleague') return { text: '=', fill: null }
  if (card.score === null || card.fit === 'unknown') return { text: '?', fill: null }
  return { text: String(card.score), fill: card.score / 10 }
}

// Same picture for the same card, so an unchanged verdict isn't resent.
export function badgeKey(card: Card) {
  const g = glyph(card)
  return `${g.text}:${g.fill}`
}

export async function badgePng(card: Card): Promise<Uint8Array> {
  const size = BADGE_SIZE
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size)

  const { text, fill } = glyph(card)
  const r = size / 2 - 6
  const c = size / 2
  ctx.lineWidth = 6
  ctx.lineCap = 'round'
  // Track: dim, so the filled part stands out.
  ctx.strokeStyle = '#444'
  ctx.beginPath()
  ctx.arc(c, c, r, 0, Math.PI * 2)
  ctx.stroke()
  if (fill !== null && fill > 0) {
    ctx.strokeStyle = '#fff'
    ctx.beginPath()
    ctx.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fill)
    ctx.stroke()
  }

  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold ${text.length > 1 ? 26 : 36}px system-ui, sans-serif`
  ctx.fillText(text, c, c + 2)

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('badge: canvas gave no PNG')
  return new Uint8Array(await blob.arrayBuffer())
}
