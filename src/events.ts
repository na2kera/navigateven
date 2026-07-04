import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

// protobuf convention elides fields holding the default value, and
// CLICK_EVENT = 0 is the enum default — so a host may send a click as a
// channel object with no eventType at all (the simulator sends an explicit 0,
// which is why this only bites on other hosts). A present channel with a
// missing eventType therefore IS a click. All other events are nonzero and
// always arrive explicit. (issue #11-1)
function channelEventType(
  channel: { eventType?: OsEventTypeList } | undefined,
): OsEventTypeList | null {
  if (!channel) return null
  return channel.eventType ?? OsEventTypeList.CLICK_EVENT
}

export function resolveEventType(event: EvenHubEvent): OsEventTypeList | null {
  return (
    channelEventType(event.sysEvent) ??
    channelEventType(event.textEvent) ??
    channelEventType(event.listEvent)
  )
}
