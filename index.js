import './src/installAppLogCapture';
import './src/logBoxWarnings';
import { registerRootComponent } from 'expo';
import { AppRegistry, DeviceEventEmitter } from 'react-native';
import './src/i18n';
import App from './App';

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

registerRootComponent(App);
