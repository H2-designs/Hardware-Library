package com.ciontek.HardwareDemo

import com.rabbah.mdb.HardwareLib
import com.rabbah.mqtt.MdbLogEvent
import com.rabbah.mqtt.MqttLib
import com.rabbah.mqtt.RabbahLog

/**
 * The ONLY place the hardware library and the MQTT library meet. HardwareLib knows nothing
 * about MQTT anymore - it emits structured events through its listeners - and this bridge is
 * the ~30 lines of glue that puts those events on the wire in the exact format the dashboard
 * already speaks (byte-identical to when the MQTT code lived inside the library):
 *
 *  - exchangeListener  -> RabbahLog.log(codebook event, params)   [RABBAH_LOG:{...} items]
 *  - controlListener   -> MqttLib.enqueue("TAG:json")             [VMC_STATUS:/SETTINGS_JSON:/...]
 *  - MQTT commands     -> HardwareLib.handleCommand(text)         [open/close/vendApprove/...]
 *
 * An app that wants a different transport (HTTP, BLE, none) simply writes its own version of
 * this file against the same three hooks - the library itself never changes.
 */
object MdbMqttBridge {

    fun attach() {
        // Inbound: every dashboard/backend command goes straight to the library's single
        // transport-agnostic entry point. It returns false for non-MDB commands, so the
        // chain continues to any listener the app added after this one.
        MqttLib.addCommandListener(commandForwarder)

        // Outbound control plane: tag "LOG" is a plain report line (shipped bare, exactly as
        // before); every other tag is a control message the dashboard matches by its prefix.
        HardwareLib.controlListener = { tag, payload ->
            if (tag == "LOG") MqttLib.enqueue(payload) else MqttLib.enqueue("$tag:$payload")
        }

        // Outbound exchanges: the event's logEventName maps 1:1 onto the Rabbah MDB codebook,
        // and its params are already in codebook order (p[0]=rx, p[1]=tx, extras). publishRemote
        // carries the library's setMqttLogging gate, so muting works exactly as it always did.
        HardwareLib.exchangeListener = { e ->
            if (e.publishRemote) {
                RabbahLog.sessionId = e.sessionId
                val event = try {
                    MdbLogEvent.valueOf(e.logEventName)
                } catch (_: IllegalArgumentException) {
                    null // a CMD newer than this mqtt-lib's codebook - ship as free text instead
                }
                if (event != null) RabbahLog.log(event, e.params) else RabbahLog.raw(e.message)
            }
        }
    }

    fun detach() {
        MqttLib.removeCommandListener(commandForwarder)
        HardwareLib.controlListener = null
        HardwareLib.exchangeListener = null
    }

    private val commandForwarder: (String) -> Boolean = { HardwareLib.handleCommand(it) }
}
