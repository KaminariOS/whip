import './src/installAppLogCapture';
import './src/logBoxWarnings';
import { registerRootComponent } from 'expo';
import { AppRegistry, DeviceEventEmitter, Platform, Settings } from 'react-native';
import './src/i18n';
import App from './App';
import { IosSshE2EScreen } from './src/components/IosSshE2EScreen';

const BACKGROUND_MONITORING_TASK = 'HerdrBackgroundMonitoring';
const BACKGROUND_MONITORING_STOP_EVENT = 'HerdrBackgroundMonitoringStopped';
const backgroundMonitoringStops = new Set();

DeviceEventEmitter.addListener(BACKGROUND_MONITORING_STOP_EVENT, () => {
  for (const stop of backgroundMonitoringStops) stop();
  backgroundMonitoringStops.clear();
});

AppRegistry.registerHeadlessTask(BACKGROUND_MONITORING_TASK, () => () => (
  new Promise(resolve => {
    backgroundMonitoringStops.add(resolve);
  })
));

const iosE2EFlag = Settings.get('WhipE2EEnabled');
const iosE2EEnabled = Platform.OS === 'ios'
  && [true, 1, '1', 'YES', 'true'].includes(iosE2EFlag);
const RootComponent = iosE2EEnabled
  ? IosSshE2EScreen
  : App;

registerRootComponent(RootComponent);
