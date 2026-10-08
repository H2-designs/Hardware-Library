package com.rabbah.samples

import android.app.Application
import android.util.Log
import com.rabbah.mdb.HardwareLib
import com.rabbah.mdb.PulseLib
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Pulse machine integration, end to end - hardware-lib 8.2.0 / PulseLib.
 *
 * What a pulse machine is: the CM30 gives credit as coin pulses on one digital output; some machines
 * raise a digital input to say "ready for credit". The library drives every pulse edge itself on a
 * high-priority thread - the app never touches the IO.
 *
 * The flow this file shows:
 *   1. app start      -> HardwareLib.init(context)                        (persistence; once per process)
 *   2. machine config -> PulseLib.initPulse(polarity) + the ready gate    (once per machine, persisted)
 *   3. a sale         -> isMachineReady -> charge card -> sendPulse -> capture or refund
 *
 * Everything here also has a remote twin the dashboard sends with no app code:
 *   initPulse:true|false, setReadyFeedback:yes,1,0 | 0=1,2=0 | off, checkMachineReady, sendPulse:50,100,3
 */

// --------------------------------------------------------------------------------------------------
// 1. App start - once per process. Without init() nothing below persists across restarts.
// --------------------------------------------------------------------------------------------------
class VendingApp : Application() {
    override fun onCreate() {
        super.onCreate()
        HardwareLib.init(applicationContext)   // restores pulseMode + ready gate and re-drives the idle level
        // (MQTT / MqttLib.init + start go here too when the dashboard link is wanted - not needed for pulsing)
    }
}

// --------------------------------------------------------------------------------------------------
// 2. Machine configuration - what the backend machine model carries for a pulse machine.
//    Apply it once when the machine is assigned (and again whenever the model changes). Persisted.
// --------------------------------------------------------------------------------------------------
data class PulseMachineModel(
    val pulseHigh: Boolean,                 // true = HIGH pulses, line idles LOW; false = the reverse
    val pulseWidthMs: Int,                  // ON time of one pulse, e.g. 50
    val pulsePeriodMs: Int,                 // start-to-start time between pulses, e.g. 100 (must be > width)
    val minorUnitsPerPulse: Int,            // e.g. 100 = one pulse per 1.00 SAR
    val readyFeedback: Map<Int, Int>,       // digital input -> value that means READY; empty = no gate
)

object PulseMachine {
    private const val TAG = "PulseMachine"
    @Volatile private var model: PulseMachineModel? = null

    /** Call once per machine. Safe to call again with the same values. */
    fun configure(m: PulseMachineModel): Boolean {
        model = m
        // Polarity: persisted as pulseMode and re-driven at every app start by HardwareLib.init().
        val ok = PulseLib.initPulse(m.pulseHigh)
        if (!ok) Log.e(TAG, "initPulse failed - no CM30 runtime or IO rejected; pulses will be refused")
        // Ready gate: all listed inputs must show their ready value before any train goes out.
        // Empty map = gate off = every train allowed.
        PulseLib.setReadyFeedbackChannels(m.readyFeedback)
        return ok
    }

    /** Price in minor units -> number of pulses the machine expects. Round UP so the customer never underpays
     *  the machine; charge exactly pulses x minorUnitsPerPulse so the two sides agree. */
    fun pulsesFor(priceMinorUnits: Int): Int {
        val unit = model?.minorUnitsPerPulse ?: 100
        return (priceMinorUnits + unit - 1) / unit
    }
}

// --------------------------------------------------------------------------------------------------
// 3. A sale. The money follows the pulses: authorize first, pulse, capture only when every pulse went out.
// --------------------------------------------------------------------------------------------------
interface PaymentGateway {
    suspend fun authorize(minorUnits: Int): String?   // returns a hold id, or null when declined
    suspend fun capture(holdId: String)
    suspend fun voidHold(holdId: String)
}

sealed class SaleResult {
    data class Paid(val pulses: Int, val minorUnits: Int) : SaleResult()
    object MachineNotReady : SaleResult()
    object Declined : SaleResult()
    data class PulseFailed(val holdVoided: Boolean) : SaleResult()
}

class PulseSale(private val gateway: PaymentGateway) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Called from the UI when the customer asks to pay [priceMinorUnits]. Never blocks the UI thread. */
    fun start(priceMinorUnits: Int, onResult: (SaleResult) -> Unit) {
        scope.launch {
            val result = run(priceMinorUnits)
            withContext(Dispatchers.Main) { onResult(result) }
        }
    }

    private suspend fun run(priceMinorUnits: Int): SaleResult {
        val model = PulseMachineModelHolder.current
        val pulses = PulseMachine.pulsesFor(priceMinorUnits)
        // Charge exactly what the pulses are worth, so the card and the machine always agree.
        val chargeMinorUnits = pulses * (model?.minorUnitsPerPulse ?: 100)

        // a. Ask the machine first - never take the card for a train the gate would refuse.
        //    Always true when no gate is configured. Logs "[pulse] ready feedback in0 expected=1 actual=.. ready=.."
        if (!PulseLib.isMachineReady()) return SaleResult.MachineNotReady

        // b. Hold the money.
        val holdId = gateway.authorize(chargeMinorUnits) ?: return SaleResult.Declined

        // c. Pulse. sendPulse BLOCKS for about period x count and returns true only when EVERY pulse
        //    physically went out - that is why this runs on Dispatchers.IO, never on Main.
        val width = model?.pulseWidthMs ?: 50
        val period = model?.pulsePeriodMs ?: 100
        val sent = PulseLib.sendPulse(pulseWidthMs = width, pulsePeriodMs = period, count = pulses)

        // d. Settle. false = no credit reached the machine (not initialised, bad timing, gate closed,
        //    queue full, hardware error) - the reason is on the log as a "[pulse] ..." line.
        return if (sent) {
            gateway.capture(holdId)
            SaleResult.Paid(pulses, chargeMinorUnits)
        } else {
            gateway.voidHold(holdId)
            SaleResult.PulseFailed(holdVoided = true)
        }
    }
}

/** Tiny holder so the sale can read the configured timing (keep your own model store in a real app). */
object PulseMachineModelHolder { @Volatile var current: PulseMachineModel? = null }

// --------------------------------------------------------------------------------------------------
// Example wiring
// --------------------------------------------------------------------------------------------------
object Example {
    fun onMachineAssigned() {
        val model = PulseMachineModel(
            pulseHigh = true,                // from the backend machine model ("Init High" on the dashboard)
            pulseWidthMs = 50,
            pulsePeriodMs = 100,
            minorUnitsPerPulse = 100,        // 1 pulse per 1.00 SAR
            readyFeedback = mapOf(0 to 1),   // input 0 must read 1; use emptyMap() for a machine without a ready line
        )
        PulseMachineModelHolder.current = model
        PulseMachine.configure(model)
    }

    fun onCustomerPays(sale: PulseSale) {
        sale.start(priceMinorUnits = 350) { result ->      // SAR 3.50 -> 4 pulses (rounded up), charged 4.00
            when (result) {
                is SaleResult.Paid -> showDone(result.pulses)
                SaleResult.MachineNotReady -> showMessage("Machine is busy, try again")
                SaleResult.Declined -> showMessage("Card declined")
                is SaleResult.PulseFailed -> showMessage("Could not credit the machine - nothing was charged")
            }
        }
    }

    // Diagnostics you can show on a service screen:
    fun pulseStatus(): String =
        "polarity=" + (if (!PulseLib.isInitialized) "unset" else if (PulseLib.isHighPulse) "HIGH" else "LOW") +
            " queued=" + PulseLib.pendingTrains +
            " gate=" + (if (PulseLib.readyFeedbackChannels.isEmpty()) "off" else PulseLib.readyFeedbackChannels.toString())

    private fun showDone(pulses: Int) {}
    private fun showMessage(text: String) {}
}
