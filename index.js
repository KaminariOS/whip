import './src/logBoxWarnings';
import { registerRootComponent } from 'expo';
import { AppRegistry, DeviceEventEmitter } from 'react-native';
import './src/i18n';
import App from './App';
import { reportBackgroundFailure } from './src/services/backgroundOperations';
import { initializeRevenueCat } from './src/services/revenueCat';

const BACKGROUND_MONITORING_TASK = 'HerdrBackgroundMonitoring';
const BACKGROUND_MONITORING_STOP_EVENT = 'HerdrBackgroundMonitoringStopped';
const backgroundMonitoringStops = new Set();

DeviceEventEmitter.addListener(BACKGROUND_MONITORING_STOP_EVENT, () => {
  for (const stop of backgroundMonitoringStops) stop();
  backgroundMonitoringStops.clear();
});

reportBackgroundFailure(initializeRevenueCat(), 'revenuecat-initialization');

AppRegistry.registerHeadlessTask(
  BACKGROUND_MONITORING_TASK,
  () => () =>
    new Promise(resolve => {
      backgroundMonitoringStops.add(resolve);
    }),
);

registerRootComponent(App);
