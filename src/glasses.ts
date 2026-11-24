import {
  type EvenAppBridge,
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'

// Two page layouts on the 576x288 display:
//   text page: one full-screen text container that captures taps
//   card page: card text on top, a Save / Skip list below that captures taps

export const TEXT_ID = 1
export const LIST_ID = 2
export const CARD_ACTIONS = ['Save lead', 'Skip'] as const

let started = false

function textContainer(content: string, height: number, capture: boolean) {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: TEXT_ID,
    containerName: 'main',
    content,
    isEventCapture: capture ? 1 : 0,
  })
}

async function show(bridge: EvenAppBridge, page: { textObject: TextContainerProperty[]; listObject?: ListContainerProperty[] }) {
  const containerTotalNum = page.textObject.length + (page.listObject?.length ?? 0)
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
  return show(bridge, { textObject: [textContainer(content, 288, true)] })
}

// Replaces the card text in place, without rebuilding the page, so the
// Save / Skip selection stays where it is.
export async function updateCardText(bridge: EvenAppBridge, content: string) {
  const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: TEXT_ID, containerName: 'main', content }))
  if (!ok) console.error('textContainerUpgrade failed')
}

export function showCard(bridge: EvenAppBridge, content: string) {
  return show(bridge, {
    textObject: [textContainer(content, 200, false)],
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
}
