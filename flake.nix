{
  description = "Whip Expo Android development environment";

  # Match the host flake so the Android shell reuses its cached JDK/SDK closure.
  inputs = {
    nixpkgs.url = "tarball+https://releases.nixos.org/nixos/unstable/nixos-26.11pre1034379.18b9261cb329/nixexprs.tar.xz";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {nixpkgs, rust-overlay, ...}: let
    androidSystem = "x86_64-linux";
    darwinSystem = "aarch64-darwin";
    androidPkgs = import nixpkgs {
      system = androidSystem;
      overlays = [ (import rust-overlay) ];
      config.allowUnfree = true;
      config.android_sdk.accept_license = true;
    };
    darwinPkgs = import nixpkgs {
      system = darwinSystem;
      overlays = [ (import rust-overlay) ];
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
    androidNdkTools = "${androidSdk}/libexec/android-sdk/ndk-bundle/toolchains/llvm/prebuilt/linux-x86_64/bin";
    androidRustToolchain = androidPkgs.rust-bin.stable."1.97.1".default.override {
      targets = ["aarch64-linux-android"];
    };
    darwinRustToolchain = darwinPkgs.rust-bin.stable."1.97.1".default.override {
      targets = ["aarch64-apple-ios"];
    };
    mkWhipPair = pkgs:
      pkgs.rustPlatform.buildRustPackage {
        pname = "whip-pair";
        version = "0.1.0";
        src = pkgs.lib.cleanSourceWith {
          src = ./whip-pair;
          filter = path: type:
            type != "directory" || builtins.baseNameOf path != "target";
        };
        cargoLock.lockFile = ./whip-pair/Cargo.lock;
        nativeBuildInputs = [pkgs.makeWrapper];

        postInstall = ''
          wrapProgram $out/bin/whip-pair \
            --prefix PATH : ${pkgs.lib.makeBinPath [pkgs.openssh]}
        '';

        meta = {
          description = "Direct, QR-based SSH public-key enrollment prototype for Whip";
          license = pkgs.lib.licenses.agpl3Plus;
          mainProgram = "whip-pair";
          platforms = pkgs.lib.platforms.unix;
        };
      };
    linuxWhipPair = mkWhipPair androidPkgs;
    darwinWhipPair = mkWhipPair darwinPkgs;
  in {
    packages.${androidSystem}.whip-pair = linuxWhipPair;
    packages.${darwinSystem}.whip-pair = darwinWhipPair;

    apps.${androidSystem}.whip-pair = {
      type = "app";
      program = "${linuxWhipPair}/bin/whip-pair";
      meta.description = "Run the Whip SSH pairing prototype";
    };
    apps.${darwinSystem}.whip-pair = {
      type = "app";
      program = "${darwinWhipPair}/bin/whip-pair";
      meta.description = "Run the Whip SSH pairing prototype";
    };

    devShells.${androidSystem}.default = androidPkgs.mkShell {
      packages = [
        androidSdk
        androidPkgs.jdk17_headless
        androidPkgs.nodejs_22
        androidRustToolchain
      ];

      ANDROID_HOME = "${androidSdk}/libexec/android-sdk";
      ANDROID_SDK_ROOT = "${androidSdk}/libexec/android-sdk";
      ANDROID_NDK_ROOT = "${androidSdk}/libexec/android-sdk/ndk-bundle";
      JAVA_HOME = androidPkgs.jdk17_headless.home;
      GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${androidSdk}/libexec/android-sdk/build-tools/36.0.0/aapt2";
      CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = "${androidNdkTools}/aarch64-linux-android24-clang";
      CC_aarch64_linux_android = "${androidNdkTools}/aarch64-linux-android24-clang";
      AR_aarch64_linux_android = "${androidNdkTools}/llvm-ar";
      CFLAGS_aarch64_linux_android = "--target=aarch64-none-linux-android24";
    };

    devShells.${darwinSystem}.default = darwinPkgs.mkShell {
      packages = with darwinPkgs; [
        nodejs_22
        watchman
        ruby_3_4
        bundler
        cocoapods
        fastlane
        darwinRustToolchain
      ];

      DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";
    };
  };
}
