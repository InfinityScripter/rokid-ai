import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.rokidai.vision"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.rokidai.vision"
        minSdk = 31
        targetSdk = 31
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "DEFAULT_URL", "\"${localProps.getProperty("rokid.url", "")}\"")
        buildConfigField("String", "DEFAULT_TOKEN", "\"${localProps.getProperty("rokid.token", "")}\"")
        buildConfigField("String", "FALLBACK_IP", "\"${localProps.getProperty("rokid.ip", "")}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    testImplementation("junit:junit:4.13.2")
}
