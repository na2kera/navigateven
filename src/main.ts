import {
  waitForEvenAppBridge,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { initGlasses, refreshDestinations, handleInput } from './glasses/nav.ts'
import { resolveEventType } from './events.ts'
import { mountPhoneUI } from './phone/ui.ts'

const bridge = await waitForEvenAppBridge()

await initGlasses(bridge)
mountPhoneUI(document.querySelector<HTMLDivElement>('#app')!)

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  unsubscribe()
}

// Event routing: resolveEventType checks sysEvent/textEvent/listEvent and
// treats a present channel with an elided eventType as CLICK_EVENT (protobuf
// omits default-valued fields — see src/events.ts).
const unsubscribe = bridge.onEvenHubEvent(event => {
  const eventType = resolveEventType(event)
  if (eventType === null) return

  if (
    eventType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    cleanup()
    return
  }

  // Foreground re-entered → reload destinations (phone side may have edited)
  if (eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    refreshDestinations()
    return
  }

  handleInput(eventType)
})

window.addEventListener('beforeunload', cleanup)
