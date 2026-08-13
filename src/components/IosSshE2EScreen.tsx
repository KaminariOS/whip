import { useEffect, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { runIosSshE2E, type IosSshE2EResult } from '../services/iosSshE2E';

export function IosSshE2EScreen() {
  const [activeStep, setActiveStep] = useState('Starting iOS SSH integration checks…');
  const [result, setResult] = useState<IosSshE2EResult | null>(null);

  useEffect(() => {
    runIosSshE2E(setActiveStep).then(setResult);
  }, []);

  const passed = result?.status === 'passed';
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.eyebrow}>WHIP IOS SSH E2E</Text>
        <Text style={styles.title}>{result ? (passed ? 'Passed' : 'Failed') : 'Running'}</Text>
        <Text style={styles.status}>{result?.error || activeStep}</Text>
        <Text style={styles.progress}>
          {result ? `${result.steps.length} checks completed` : 'Testing the Objective-C → Rust → OpenSSH path'}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#090b10', flex: 1 },
  container: { flex: 1, justifyContent: 'center', paddingHorizontal: 32 },
  eyebrow: { color: '#8ca4ff', fontSize: 12, fontWeight: '700', letterSpacing: 1.5 },
  title: { color: '#f5f7ff', fontSize: 42, fontWeight: '700', marginTop: 12 },
  status: { color: '#c9d0e3', fontSize: 16, lineHeight: 24, marginTop: 18 },
  progress: { color: '#778096', fontSize: 13, marginTop: 14 },
});
