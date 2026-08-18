#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

@interface TerminalAssetsModule : NSObject <RCTBridgeModule>
@end

@implementation TerminalAssetsModule

RCT_EXPORT_MODULE(TerminalAssets)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSDictionary *)constantsToExport
{
  NSURL *directoryURL = [[NSBundle mainBundle] URLForResource:@"TerminalAssets"
                                                withExtension:nil];
  NSURL *indexURL = [directoryURL URLByAppendingPathComponent:@"index.html"];

  return @{
    @"directoryURL": directoryURL.absoluteString ?: @"",
    @"indexURL": indexURL.absoluteString ?: @"",
  };
}

@end
