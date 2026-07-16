require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'RNSSHClient'
  s.version          = package['version']
  s.summary          = package['description']
  s.license          = package['license']
  s.homepage         = package['homepage']
  s.authors          = package['author']['name']
  s.source           = { :git => package['repository']['url'], :tag => s.version }
  s.source_files     = 'ios/**/*.{h,m}'
  s.requires_arc     = true
  s.platforms        = { :ios => "11.0", :tvos => "9.2" }

  s.dependency 'React'
  s.dependency 'NMSSH'
end
