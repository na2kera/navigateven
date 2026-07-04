import {
  waitForEvenAppBridge,
  OsEventTypeList,
  TextContainerProperty,
  CreateStartUpPageContainer,
} from '@evenrealities/even_hub_sdk'

const bridge = await waitForEvenAppBridge()

const statusText = new TextContainerProperty({
  xPosition: 20,
  yPosition: 20,
  width: 536,
  height: 248,
  containerID: 1,
  containerName: 'status',
  content: 'NavigatEven\nReady',
  isEventCapture: 1,
})

await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 1,
  textObject: [statusText],
}))

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  unsubscribe()
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = event.sysEvent?.eventType ?? null

  if (
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    cleanup()
    return
  }

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge.shutDownPageContainer(1)
  }
})

window.addEventListener('beforeunload', cleanup)
