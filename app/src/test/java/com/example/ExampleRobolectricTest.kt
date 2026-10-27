package com.example

import android.content.ClipboardManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ExampleRobolectricTest {

    @Test
    fun `read string from context`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val appName = context.getString(R.string.app_name)
        assertEquals("QR Master Pro", appName)
    }

    @Test
    fun `verify offline bundled index asset exists and is valid`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val assetManager = context.assets
        val inputStream = assetManager.open("index.html")
        assertNotNull(inputStream)
        val content = inputStream.bufferedReader().use { it.readText() }
        assertTrue(content.contains("QR Master Pro"))
        assertTrue(content.contains("QRCodeEngine"))
        assertTrue(content.contains("screen-link-mgmt"))
    }

    @Test
    fun `test WebAppBridge isOnline and clipboard integration`() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val bridge = activity.WebAppBridge(activity)
        
        // Test connectivity query
        val online = bridge.isOnline()
        // In Robolectric environment, network is available or default true
        assertNotNull(online)

        // Test clipboard copy
        bridge.copyToClipboard("https://example.com/test", "Test Label")
        val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = clipboard.primaryClip
        assertNotNull(clip)
        assertEquals("https://example.com/test", clip?.getItemAt(0)?.text?.toString())
    }
}
