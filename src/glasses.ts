import {
  type EvenAppBridge,
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { cardParts, type Card, type Check } from './api'
import { BADGE_SIZE, badgeKey, badgePng } from './badge'

// Two page layouts on the 576x288 display:
//   text page: one full-screen text container that captures taps
//   card page: score badge (image) and header top left/right, then what to
//   say, then the reason (dimmed), and a Save / Skip list that captures taps
//
//   +--------+----------------------------------+
//   | badge  | Karri Saarinen, Linear           |
//   |   9    | STRONG 9/10 - Buyer: Sales leader|
//   |        | Verified: CEO, Cofounder         |
//   +--------+----------------------------------+
//   | Ask: How do you track pipeline today?     |
//   | B2B software CEO, decision maker   (dim)  |
//   | [Save lead]  Skip                         |

export const TEXT_ID = 1 // the text page's container, and the card header
export const LIST_ID = 2
export const IMAGE_ID = 3
export const ASK_ID = 4
export const WHY_ID = 5
const BRIGHT = 4
const DIM = 2
export const CARD_ACTIONS = ['Save lead', 'Skip'] as const

let started = false

function textContainer(
  content: string,
  box: { x: number; y: number; w: number; h: number },
  opts: { id?: number; name?: string; capture?: boolean; brightness?: number } = {},
) {
  return new TextContainerProperty({
    xPosition: box.x,
    yPosition: box.y,
    width: box.w,
    height: box.h,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: opts.id ?? TEXT_ID,
    containerName: opts.name ?? 'main',
    content,
    isEventCapture: opts.capture ? 1 : 0,
    ...(opts.brightness === undefined ? {} : { textColor: opts.brightness }),
  })
}

type Page = { textObject: TextContainerProperty[]; listObject?: ListContainerProperty[]; imageObject?: ImageContainerProperty[] }

async function show(bridge: EvenAppBridge, page: Page) {
  const containerTotalNum = page.textObject.length + (page.listObject?.length ?? 0) + (page.imageObject?.length ?? 0)
  if (!started) {
    started = true
    const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum, ...page }))
    if (result !== 0) console.error('createStartUpPageContainer failed:', result)
    return
  }
  const ok = await bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum, ...page }))
  if (!ok) console.error('rebuildPageContainer failed')
}

export function showText(bridge: EvenAppBridge, content: string) {
  return show(bridge, { textObject: [textContainer(content, { x: 0, y: 0, w: 576, h: 288 }, { capture: true })] })
}

// Replaces the card text in place, without rebuilding the page, so the
// Save / Skip selection stays where it is.
export async function updateCardText(bridge: EvenAppBridge, content: string) {
  const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: TEXT_ID, containerName: 'main', content }))
  if (!ok) console.error('textContainerUpgrade failed')
}

// Image sends must not overlap, so they queue; an unchanged badge isn't resent.
let badgeQueue: Promise<unknown> = Promise.resolve()
let badgeShown = ''

function sendBadge(bridge: EvenAppBridge, card: Card) {
  const key = badgeKey(card)
  if (key === badgeShown) return badgeQueue
  badgeShown = key
  badgeQueue = badgeQueue
    .then(async () => {
      const result = await bridge.updateImageRawData(
        new ImageRawDataUpdate({ containerID: IMAGE_ID, containerName: 'badge', imageData: await badgePng(card) }),
      )
      if (result !== 'success') console.error('badge image failed:', result)
    })
    .catch(err => console.error('badge image failed:', err))
  return badgeQueue
}

// Updates the card in place, without rebuilding the page, so the Save / Skip
// selection stays where it is.
export async function updateCard(bridge: EvenAppBridge, card: Card, check: Check) {
  const parts = cardParts(card, check)
  const update = (containerID: number, containerName: string, content: string) =>
    bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID, containerName, content }))
  const ok = await Promise.all([update(TEXT_ID, 'main', parts.header), update(ASK_ID, 'ask', parts.ask), update(WHY_ID, 'why', parts.why)])
  if (ok.includes(false)) console.error('textContainerUpgrade failed')
  await sendBadge(bridge, card)
}

export async function showCard(bridge: EvenAppBridge, card: Card, check: Check) {
  const parts = cardParts(card, check)
  const pad = 4
  badgeShown = '' // a rebuilt page starts with an empty image container
  await show(bridge, {
    imageObject: [
      new ImageContainerProperty({
        xPosition: pad,
        yPosition: pad,
        width: BADGE_SIZE,
        height: BADGE_SIZE,
        containerID: IMAGE_ID,
        containerName: 'badge',
      }),
    ],
    textObject: [
      textContainer(parts.header, { x: BADGE_SIZE + 2 * pad, y: 0, w: 576 - BADGE_SIZE - 2 * pad, h: 92 }, { brightness: BRIGHT }),
      textContainer(parts.ask, { x: 0, y: 94, w: 576, h: 58 }, { id: ASK_ID, name: 'ask', brightness: BRIGHT }),
      textContainer(parts.why, { x: 0, y: 152, w: 576, h: 50 }, { id: WHY_ID, name: 'why', brightness: DIM }),
    ],
    listObject: [
      new ListContainerProperty({
        xPosition: 0,
        yPosition: 204,
        width: 576,
        height: 84,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 2,
        containerID: LIST_ID,
        containerName: 'actions',
        isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: CARD_ACTIONS.length,
          isItemSelectBorderEn: 1,
          itemName: [...CARD_ACTIONS],
        }),
      }),
    ],
  })
  await sendBadge(bridge, card)
}
