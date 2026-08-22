plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.rokidai.vats"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.rokidai.vats"
        minSdk = 31
        targetSdk = 31
        versionCode = 1
        versionName = "0.1.0"
    }

    androidResources {
        noCompress += "tflite"
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
    implementation("org.tensorflow:tensorflow-lite:2.14.0")
    testImplementation("junit:junit:4.13.2")
}
