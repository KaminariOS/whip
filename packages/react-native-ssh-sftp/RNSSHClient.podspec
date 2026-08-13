require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
rust_library = File.join(__dir__, 'rust', 'build', '$(PLATFORM_NAME)', '$(CONFIGURATION)', 'libwhip_ssh.a')

Pod::Spec.new do |s|
  s.name             = 'RNSSHClient'
  s.version          = package['version']
  s.summary          = package['description']
  s.license          = package['license']
  s.homepage         = package['homepage']
  s.authors          = package['author']['name']
  s.source           = { :git => package['repository']['url'], :tag => s.version }
  s.source_files     = 'ios/RNSSHRustClient.{h,m}', 'rust/include/*.h'
  s.public_header_files = 'ios/RNSSHRustClient.h', 'rust/include/*.h'
  s.preserve_paths   = 'rust/**/*'
  s.requires_arc     = true
  s.platforms        = { :ios => "16.4" }

  s.dependency 'React'
  s.frameworks = 'Security'
  s.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/rust/include"',
    'LIBRARY_SEARCH_PATHS' => "$(inherited) \"#{File.dirname(rust_library)}\"",
    'OTHER_LDFLAGS' => '$(inherited) -lwhip_ssh'
  }
  # The pod itself is a static archive, so the final app link must also see
  # the Rust archive; pod-target linker flags alone do not propagate there.
  s.user_target_xcconfig = {
    'LIBRARY_SEARCH_PATHS' => "$(inherited) \"#{File.dirname(rust_library)}\"",
    'OTHER_LDFLAGS' => '$(inherited) -lwhip_ssh'
  }
  s.script_phase = {
    :name => 'Build Rust SSH transport',
    :script => 'bash "${PODS_TARGET_SRCROOT}/rust/build-ios.sh"',
    :execution_position => :before_compile,
    :input_files => [
      '${PODS_TARGET_SRCROOT}/rust/Cargo.toml',
      '${PODS_TARGET_SRCROOT}/rust/Cargo.lock',
      '${PODS_TARGET_SRCROOT}/rust/rust-toolchain.toml',
      '${PODS_TARGET_SRCROOT}/rust/build-ios.sh',
      '${PODS_TARGET_SRCROOT}/rust/src/lib.rs',
      '${PODS_TARGET_SRCROOT}/rust/src/herdr_codec.rs',
      '${PODS_TARGET_SRCROOT}/rust/src/known_hosts.rs'
    ],
    :output_files => ['${PODS_TARGET_SRCROOT}/rust/build/${PLATFORM_NAME}/${CONFIGURATION}/libwhip_ssh.a']
  }
end
