package ca.pkay.rcloneexplorer.workmanager

import android.app.Notification
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Parcel
import androidx.annotation.StringRes
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import androidx.preference.PreferenceManager
import androidx.work.ForegroundInfo
import androidx.work.Worker
import androidx.work.WorkerParameters
import ca.pkay.rcloneexplorer.Items.FileItem
import ca.pkay.rcloneexplorer.Items.RemoteItem
import ca.pkay.rcloneexplorer.Log2File
import ca.pkay.rcloneexplorer.R
import ca.pkay.rcloneexplorer.Rclone
import ca.pkay.rcloneexplorer.notifications.prototypes.WorkerNotification
import ca.pkay.rcloneexplorer.notifications.support.StatusObject
import ca.pkay.rcloneexplorer.util.FLog
import ca.pkay.rcloneexplorer.util.SyncLog
import ca.pkay.rcloneexplorer.util.WifiConnectivitiyUtil
import de.felixnuesse.extract.extensions.tag
import de.felixnuesse.extract.notifications.implementations.DownloadWorkerNotification
import org.json.JSONException
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.io.InterruptedIOException
import kotlin.random.Random
import android.util.Log
import de.felixnuesse.extract.notifications.implementations.DeleteWorkerNotification
import de.felixnuesse.extract.notifications.implementations.MoveWorkerNotification
import de.felixnuesse.extract.notifications.implementations.UploadWorkerNotification


class EphemeralWorker (private var mContext: Context, workerParams: WorkerParameters): Worker(mContext, workerParams) {


    companion object {
        const val EPHEMERAL_TYPE = "TASK_EPHEMERAL_TYPE"
        const val REMOTE = "REMOTE"

        const val DOWNLOAD_TARGETPATH = "DOWNLOAD_TARGETPATH"
        const val DOWNLOAD_SOURCE = "DOWNLOAD_SOURCE"

        const val UPLOAD_FILE = "UPLOAD_FILE"
        const val UPLOAD_TARGETPATH = "UPLOAD_TARGETPATH"

        const val MOVE_FILE = "MOVE_FILE"
        const val MOVE_TARGETPATH = "MOVE_TARGETPATH"

        const val DELETE_FILE = "DELETE_FILE"
    }

    internal enum class FAILURE_REASON {
        NO_FAILURE, NO_UNMETERED, NO_CONNECTION, RCLONE_ERROR, CONNECTIVITY_CHANGED, CANCELLED, NO_TASK
    }

    // Objects
    private var mNotificationManager: WorkerNotification? = null
    private val mPreferences = PreferenceManager.getDefaultSharedPreferences(mContext)


    private var log2File: Log2File? = null


    // States
    private val sIsLoggingEnabled = mPreferences.getBoolean(getString(R.string.pref_key_logs), false)
    private var sConnectivityChanged = false

    private var sRcloneProcess: Process? = null
    private val statusObject = StatusObject(mContext)
    private var failureReason = FAILURE_REASON.NO_FAILURE
    private var endNotificationAlreadyPosted = false
    private var silentRun = false
    private var receiverRegistered = false
    private val ongoingNotificationID = Random.nextInt()


    private var mTitle: String = mNotificationManager?.initialTitle ?: ""

    override fun doWork(): Result {

        val type = try {
            Type.valueOf(inputData.getString(EPHEMERAL_TYPE) ?: "")
        } catch (e: IllegalArgumentException) {
            log("Critical: No valid ephemeral type passed!")
            return Result.failure()
        }

        // Create the type-specific notification before the first foreground update.
        // Previously this happened after the initial update, so uploads could start
        // without any visible notification at all.
        mNotificationManager = prepareNotificationManager(type)
        mNotificationManager?.generateChannels()
        mTitle = mNotificationManager?.initialTitle ?: mContext.getString(R.string.loading)
        mNotificationManager?.setCancelId(id)

        registerBroadcastReceivers()
        updateForegroundNotification(mNotificationManager?.updateNotification(
            mTitle,
            mTitle,
            ArrayList(),
            0,
            ongoingNotificationID
        ))

        val remoteItem = getRemoteitemFromParcel(REMOTE)
        if(remoteItem == null){
            log("$REMOTE: No valid remote was passed!")
            failureReason = FAILURE_REASON.NO_TASK
            postSync()
            return Result.failure()
        }

        if(!preconditionsMet()) {
            log("Preconditions are not met!")
            postSync()
            return Result.failure()
        }

        // Do not instantiate rclone when the input is invalid. It will immediately run.
        when(type){
            Type.DOWNLOAD -> {
                val target = inputData.getString(DOWNLOAD_TARGETPATH)
                val fileItem = getFileitemFromParcel(DOWNLOAD_SOURCE)

                if(fileItem == null || target.isNullOrBlank()){
                    log("$DOWNLOAD_SOURCE or $DOWNLOAD_TARGETPATH: No valid target was passed!")
                    failureReason = FAILURE_REASON.NO_TASK
                    postSync()
                    return Result.failure()
                }

                sRcloneProcess = Rclone(mContext).downloadFile(
                    remoteItem,
                    fileItem,
                    target
                )
            }
            Type.UPLOAD -> {
                val target = inputData.getString(UPLOAD_TARGETPATH)
                val file = inputData.getString(UPLOAD_FILE)

                if(target.isNullOrBlank() || file.isNullOrBlank() || !File(file).exists()){
                    log("$UPLOAD_FILE or $UPLOAD_TARGETPATH: No valid upload input was passed!")
                    failureReason = FAILURE_REASON.NO_TASK
                    postSync()
                    return Result.failure()
                }

                sRcloneProcess = Rclone(mContext).uploadFile(
                    remoteItem,
                    target,
                    file
                )
            }
            Type.MOVE -> {
                val target = inputData.getString(MOVE_TARGETPATH)
                val fileItem = getFileitemFromParcel(MOVE_FILE)

                if(fileItem == null || target.isNullOrBlank()){
                    log("$MOVE_FILE or $MOVE_TARGETPATH: No valid target was passed!")
                    failureReason = FAILURE_REASON.NO_TASK
                    postSync()
                    return Result.failure()
                }

                sRcloneProcess = Rclone(mContext).moveTo(
                    remoteItem,
                    fileItem,
                    target
                )
            }
            Type.DELETE -> {
                val fileItem = getFileitemFromParcel(DELETE_FILE)

                if(fileItem == null){
                    log("$DELETE_FILE: No valid target was passed!")
                    failureReason = FAILURE_REASON.NO_TASK
                    postSync()
                    return Result.failure()
                }

                sRcloneProcess = Rclone(mContext).deleteItems(
                    remoteItem,
                    fileItem
                )
            }
        }

        handleSync(mTitle)
        if (type == Type.UPLOAD && failureReason == FAILURE_REASON.NO_FAILURE) {
            sendUploadFinishedBroadcast(remoteItem.name, inputData.getString(UPLOAD_TARGETPATH))
        }

        postSync()
        // Indicate whether the work finished successfully with the Result.
        return if (failureReason == FAILURE_REASON.NO_FAILURE) {
            Result.success()
        } else {
            Result.failure()
        }
    }

    override fun onStopped() {
        super.onStopped()
        SyncLog.info(mContext, mTitle, mContext.getString(R.string.operation_sync_cancelled))
        SyncLog.info(mContext, mTitle, statusObject.toString())
        failureReason = FAILURE_REASON.CANCELLED
        finishWork()
    }

    private fun finishWork() {
        sRcloneProcess?.destroy()
        unregisterBroadcastReceiver()
        postSync()
    }

    fun prepareNotificationManager(type: Type): WorkerNotification {
        return when(type){
            Type.DOWNLOAD -> DownloadWorkerNotification(mContext)
            Type.UPLOAD -> UploadWorkerNotification(mContext)
            Type.DELETE -> DeleteWorkerNotification(mContext)
            Type.MOVE -> MoveWorkerNotification(mContext)
        }
    }

    private fun handleSync(title: String) {
        if (sRcloneProcess != null) {
            val localProcessReference = sRcloneProcess!!
            try {
                val reader = BufferedReader(InputStreamReader(localProcessReference.errorStream))
                val iterator = reader.lineSequence().iterator()
                while(iterator.hasNext()) {
                    val line = iterator.next()
                    try {
                        val logline = JSONObject(line)
                        val level = logline.optString("level")
                        // rclone emits normal transfer statistics at NOTICE level.
                        // Parsing only errors/warnings made the progress bar remain empty.
                        if (level == "error") {
                            if (sIsLoggingEnabled) {
                                log2File?.log(line)
                            }
                        }
                        if (level == "error" || level == "warning" || logline.has("stats")) {
                            statusObject.parseLoglineToStatusObject(logline)
                        }

                        updateForegroundNotification(mNotificationManager?.updateNotification(
                            title,
                            statusObject.notificationContent,
                            statusObject.notificationBigText,
                            statusObject.notificationPercent,
                            ongoingNotificationID
                        ))
                    } catch (e: JSONException) {
                        Log.e(tag(), "Error: the offending line: $line")
                        //FLog.e(TAG, "onHandleIntent: error reading json", e)
                    }
                }
            } catch (e: InterruptedIOException) {
                FLog.e(tag(), "onHandleIntent: I/O interrupted, stream closed", e)
                if (failureReason == FAILURE_REASON.NO_FAILURE) {
                    failureReason = FAILURE_REASON.RCLONE_ERROR
                }
            } catch (e: IOException) {
                FLog.e(tag(), "onHandleIntent: error reading stdout", e)
                if (failureReason == FAILURE_REASON.NO_FAILURE) {
                    failureReason = FAILURE_REASON.RCLONE_ERROR
                }
            }
            try {
                val exitCode = localProcessReference.waitFor()
                if (exitCode != 0 && failureReason == FAILURE_REASON.NO_FAILURE) {
                    failureReason = FAILURE_REASON.RCLONE_ERROR
                }
            } catch (e: InterruptedException) {
                FLog.e(tag(), "onHandleIntent: error waiting for process", e)
                if (failureReason == FAILURE_REASON.NO_FAILURE) {
                    failureReason = FAILURE_REASON.RCLONE_ERROR
                }
            }
        } else {
            log("Sync: No Rclone Process!")
            if (failureReason == FAILURE_REASON.NO_FAILURE) {
                failureReason = FAILURE_REASON.RCLONE_ERROR
            }
        }
        mNotificationManager?.cancelSyncNotification(ongoingNotificationID)
    }

    private fun postSync() {
        if (endNotificationAlreadyPosted) {
            return
        }
        if (silentRun) {
            unregisterBroadcastReceiver()
            endNotificationAlreadyPosted = true
            return
        }

        val notificationId = System.currentTimeMillis().toInt()

        var content = mContext.getString(R.string.operation_failed_unknown, mTitle)
        when (failureReason) {
            FAILURE_REASON.NO_FAILURE -> {
                unregisterBroadcastReceiver()
                showSuccessNotification(notificationId)
                endNotificationAlreadyPosted = true
                return
            }
            FAILURE_REASON.CANCELLED -> {
                showCancelledNotification(notificationId)
                endNotificationAlreadyPosted = true
                return
            }
            FAILURE_REASON.NO_TASK -> {
                content = getString(R.string.operation_failed_notask)
            }
            FAILURE_REASON.CONNECTIVITY_CHANGED -> {
                content = mContext.getString(R.string.operation_failed_data_change, mTitle)
            }
            FAILURE_REASON.NO_UNMETERED -> {
                content = mContext.getString(R.string.operation_failed_no_unmetered, mTitle)
            }
            FAILURE_REASON.NO_CONNECTION -> {
                content = mContext.getString(R.string.operation_failed_no_connection, mTitle)
            }
            FAILURE_REASON.RCLONE_ERROR -> {
                content = mContext.getString(R.string.operation_failed_unknown_rclone_error, mTitle)
            }
        }
        showFailNotification(notificationId, content)
        endNotificationAlreadyPosted = true
        finishWork()
    }

    private fun showCancelledNotification(notificationId: Int) {
        val content = mContext.getString(R.string.operation_failed_cancelled)
        SyncLog.info(mContext, mTitle, content)
        mNotificationManager?.showCancelledNotification(
            mTitle,
            content,
            notificationId,
            0
        )
    }

    private fun showSuccessNotification(notificationId: Int) {
        //Todo: Show sync-errors in notification. Also see line 169
        //Todo: This should be context dependend on the type. It is currently not!


        var message = mNotificationManager?.generateSuccessMessage(statusObject, getCurrentFile())?: "error"

        mNotificationManager?.showSuccessNotification(
            mTitle,
            message,
            notificationId
        )

        message += """
                        
        Est. Speed: ${statusObject.getEstimatedAverageSpeed()}
        Avg. Speed: ${statusObject.getLastItemAverageSpeed()}
                        """.trimIndent()
        //SyncLog.info(mContext, mContext.getString(R.string.operation_success, mTitle), message)
    }

    private fun showFailNotification(notificationId: Int, content: String, wasCancelled: Boolean = false) {
        var text = content
        //Todo: check if we should also add errors on success
        statusObject.printErrors()
        val errors = statusObject.getAllErrorMessages()
        if (errors.isNotEmpty()) {
            text += """
                        
                        
                        
                        ${statusObject.getAllErrorMessages()}
                        """.trimIndent()
        }

        var notifyTitle = mContext.getString(R.string.operation_failed)
        if (wasCancelled) {
            notifyTitle = mContext.getString(R.string.operation_failed_cancelled)
        }
        SyncLog.error(mContext, notifyTitle, "$mTitle: $text")
        mNotificationManager?.showFailedNotification(
            mTitle,
            text,
            notificationId,
           0
        )
    }

    private fun preconditionsMet(): Boolean {
        val wifiOnly = mPreferences.getBoolean(mContext.getString(R.string.pref_key_wifi_only_transfers), false)
        val connection = WifiConnectivitiyUtil.dataConnection(this.applicationContext)
        if (wifiOnly && connection === WifiConnectivitiyUtil.Connection.METERED) {
            failureReason = FAILURE_REASON.NO_UNMETERED
            return false
        } else if (connection === WifiConnectivitiyUtil.Connection.DISCONNECTED || connection === WifiConnectivitiyUtil.Connection.NOT_AVAILABLE) {
            failureReason = FAILURE_REASON.NO_CONNECTION
            return false
        }

        return true
    }

    private fun sendUploadFinishedBroadcast(remote: String, path: String?) {
        val intent = Intent()
        intent.action = getString(R.string.background_service_broadcast)
        intent.putExtra(getString(R.string.background_service_broadcast_data_remote), remote)
        intent.putExtra(getString(R.string.background_service_broadcast_data_path), path)
        LocalBroadcastManager.getInstance(mContext).sendBroadcast(intent)
    }

    // Creates an instance of ForegroundInfo which can be used to update the
    // ongoing notification.
    private fun updateForegroundNotification(notification: Notification?) {

        notification?.let {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                setForegroundAsync(ForegroundInfo(ongoingNotificationID, it, FOREGROUND_SERVICE_TYPE_DATA_SYNC))
            } else {
                setForegroundAsync(ForegroundInfo(ongoingNotificationID, it))
            }
        }
    }


    private fun log(message: String) {
        FLog.e(tag(), "EphemeralWorker: $message")
    }

    private fun getString(@StringRes resId: Int?): String {
        return if (resId == null) {
            "Error"
        } else {
            mContext.getString(resId)
        }
    }

    private fun registerBroadcastReceivers() {
        if (receiverRegistered) {
            return
        }
        val intentFilter = IntentFilter()
        intentFilter.addAction(WifiManager.SUPPLICANT_CONNECTION_CHANGE_ACTION)
        mContext.registerReceiver(connectivityChangeBroadcastReceiver, intentFilter)
        receiverRegistered = true
    }

    private fun unregisterBroadcastReceiver() {
        if (!receiverRegistered) {
            return
        }
        try {
            mContext.unregisterReceiver(connectivityChangeBroadcastReceiver)
        } catch (e: IllegalArgumentException) {
            // The receiver may already have been removed by the system during stop.
        } finally {
            receiverRegistered = false
        }
    }

    private val connectivityChangeBroadcastReceiver: BroadcastReceiver =
        object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if(endNotificationAlreadyPosted){
                    return
                }
                sConnectivityChanged = true
                failureReason = FAILURE_REASON.CONNECTIVITY_CHANGED
            }
        }

    private fun getFileitemFromParcel(key: String): FileItem {

        val sourceParcelByteArray = inputData.getByteArray(key)
        if(sourceParcelByteArray == null){
            log("No valid target was passed!")
            throw NullPointerException("The passed FileItem was null. We cannot continue!")
        }

        val parcel = Parcel.obtain()
        parcel.unmarshall(sourceParcelByteArray, 0, sourceParcelByteArray.size)
        parcel.setDataPosition(0)
        return FileItem.CREATOR.createFromParcel(parcel)
    }

    private fun getRemoteitemFromParcel(key: String): RemoteItem? {

        val sourceParcelByteArray = inputData.getByteArray(key)
        if(sourceParcelByteArray == null){
            log("No valid target was passed!")
            return null
        }

        val parcel = Parcel.obtain()
        parcel.unmarshall(sourceParcelByteArray, 0, sourceParcelByteArray.size)
        parcel.setDataPosition(0)
        return RemoteItem.CREATOR.createFromParcel(parcel)
    }

    private fun getCurrentFile(): FileItem {
        return when(Type.valueOf(inputData.getString(EPHEMERAL_TYPE)?:Type.DOWNLOAD.name)){
            Type.DOWNLOAD -> {
                getFileitemFromParcel(DOWNLOAD_SOURCE)
            }
            Type.UPLOAD -> {
                val pathAndName = inputData.getString(UPLOAD_FILE) ?: ""
                val name = pathAndName.substring(pathAndName.lastIndexOf("/")+1, pathAndName.length)
                val path = pathAndName.substring(0, pathAndName.lastIndexOf("/")+1)
                // TODO: Make this work properly! All the params are guessed!
                FileItem(
                        RemoteItem("", ""),
                        path,
                        name,
                        0L,
                        "modTime",
                        "mimeType",
                        false,
                        false)
            }
            Type.MOVE -> {
                getFileitemFromParcel(MOVE_FILE)
            }
            Type.DELETE -> {
                getFileitemFromParcel(DELETE_FILE)
            }
        }
    }
}
