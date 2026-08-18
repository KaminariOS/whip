import ExpoModulesCore

public final class TerminalAssetsModule: Module {
  private static let resourceBundleName = "WhipTerminalAssets"

  private var resourceBundle: Bundle? {
    let containers = [Bundle.main, Bundle(for: TerminalAssetsModule.self)]

    for container in containers {
      if let url = container.url(
        forResource: Self.resourceBundleName,
        withExtension: "bundle"
      ), let bundle = Bundle(url: url) {
        return bundle
      }
    }

    for framework in Bundle.allFrameworks {
      if let url = framework.url(
        forResource: Self.resourceBundleName,
        withExtension: "bundle"
      ), let bundle = Bundle(url: url) {
        return bundle
      }
    }

    return nil
  }

  public func definition() -> ModuleDefinition {
    Name("TerminalAssets")

    Constant("directoryURL") {
      resourceBundle?.bundleURL.absoluteString ?? ""
    }

    Constant("indexURL") {
      resourceBundle?.url(forResource: "index", withExtension: "html")?.absoluteString ?? ""
    }
  }
}
