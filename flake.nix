{
  description = "Whip Expo Android development environment";

  # Match the host flake so the Android shell reuses its cached JDK/SDK closure.
  inputs.nixpkgs.url = "tarball+https://releases.nixos.org/nixos/unstable/nixos-26.11pre1034379.18b9261cb329/nixexprs.tar.xz";

  outputs = {nixpkgs, ...}: let
    androidSystem = "x86_64-linux";
    darwinSystem = "aarch64-darwin";
    androidPkgs = import nixpkgs {
      system = androidSystem;
      config.allowUnfree = true;
      config.android_sdk.accept_license = true;
    };
    darwinPkgs = import nixpkgs {
      system = darwinSystem;
      config.allowUnfree = true;
    };

    androidComposition = androidPkgs.androidenv.composeAndroidPackages {
      platformVersions = ["36"];
      buildToolsVersions = ["35.0.0" "36.0.0"];
      cmakeVersions = ["3.22.1"];
      includeNDK = true;
      ndkVersions = ["27.1.12297006"];
    };
    androidSdk = androidComposition.androidsdk;
  in {
    devShells.${androidSystem}.default = androidPkgs.mkShell {
      packages = [
        androidSdk
        androidPkgs.jdk17_headless
        androidPkgs.nodejs_22
      ];

      ANDROID_HOME = "${androidSdk}/libexec/android-sdk";
      ANDROID_SDK_ROOT = "${androidSdk}/libexec/android-sdk";
      ANDROID_NDK_ROOT = "${androidSdk}/libexec/android-sdk/ndk-bundle";
      JAVA_HOME = androidPkgs.jdk17_headless.home;
      GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${androidSdk}/libexec/android-sdk/build-tools/36.0.0/aapt2";
    };

    devShells.${darwinSystem}.default = darwinPkgs.mkShell {
      packages = with darwinPkgs; [
        nodejs_22
        watchman
        ruby_3_4
        bundler
        cocoapods
        fastlane
      ];

      DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";
    };
  };
}
