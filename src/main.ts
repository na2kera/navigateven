import {
  waitForEvenAppBridge,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { initGlasses, refreshDestinations, handleInput } from './glasses/nav.ts'
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

// Event routing (timetableven idiom):
//   • CLICK_EVENT (0) arrives as undefined on the wire — coalesce with ?? null
//   • Scroll gestures come through sysEvent (and sometimes textEvent/listEvent)
//     so we check all three paths defensively.
const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = event.sysEvent?.eventType ?? null
  const textType = event.textEvent?.eventType ?? null
  const listType = event.listEvent?.eventType ?? null

  if (
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    cleanup()
    return
  }

  // Foreground re-entered → reload destinations (phone side may have edited)
  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    refreshDestinations()
    return
  }

  const eventType = sysType ?? textType ?? listType
  if (eventType !== null) {
    handleInput(eventType)
  }
})

window.addEventListener('beforeunload', cleanup)
