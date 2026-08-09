import React from 'react';
import {Composition} from 'remotion';
import {WhipLaunch} from './WhipLaunch';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="WhipLaunch"
    component={WhipLaunch}
    durationInFrames={600}
    fps={30}
    width={1920}
    height={1080}
  />
);
