import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import './styles.css';

const clamp = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

const fade = (frame: number, start: number, end: number) =>
  interpolate(frame, [start, start + 10, end - 10, end], [0, 1, 1, 0], clamp);

const enter = (frame: number, start: number, fps: number) =>
  spring({frame: frame - start, fps, config: {damping: 18, stiffness: 120, mass: 0.75}});

const Scene: React.FC<{start: number; end: number; children: React.ReactNode}> = ({start, end, children}) => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{opacity: fade(frame, start, end)}}>{children}</AbsoluteFill>;
};

const ProductPanel: React.FC<{
  screen: string;
  className?: string;
  frame: number;
  start: number;
  imageClass?: string;
}> = ({screen, className = '', frame, start, imageClass = ''}) => {
  const {fps} = useVideoConfig();
  const progress = enter(frame, start, fps);
  return (
    <div
      className={`product-panel ${className}`}
      style={{
        opacity: progress,
        transform: `translate3d(0, ${(1 - progress) * 90}px, 0) rotateX(${(1 - progress) * 9}deg) scale(${0.94 + progress * 0.06})`,
      }}
    >
      <div className="panel-bar"><i/><i/><i/><span>WHIP / ANDROID</span></div>
      <div className="panel-screen"><Img className={imageClass} src={staticFile(screen)} /></div>
      <div className="panel-shine" />
    </div>
  );
};

const Copy: React.FC<{
  start: number;
  kicker: string;
  title: React.ReactNode;
  body: string;
  align?: 'left' | 'right';
}> = ({start, kicker, title, body, align = 'left'}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const progress = enter(frame, start, fps);
  return (
    <div
      className={`scene-copy ${align}`}
      style={{opacity: progress, transform: `translateY(${(1 - progress) * 42}px)`}}
    >
      <div className="kicker"><span />{kicker}</div>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
};

export const WhipLaunch: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const hero = enter(frame, 0, fps);
  const slowDrift = Math.sin(frame / 28) * 9;
  const ringTurn = interpolate(frame, [0, 600], [-8, 28], clamp);
  const activity = interpolate(frame, [76, 102], [0, 1], clamp);

  return (
    <AbsoluteFill className="root">
      <Audio src={staticFile('audio/whip-launch.wav')} volume={0.96} />
      <div className="wash wash-a" />
      <div className="wash wash-b" />
      <div className="noise" />
      <div className="orbit orbit-a" style={{transform: `rotate(${ringTurn}deg)`}} />
      <div className="orbit orbit-b" style={{transform: `rotate(${-ringTurn * 0.6}deg)`}} />
      <div className="brand-bug"><Img src={staticFile('icon.png')} /><b>WHIP</b><span>HERDR FOR ANDROID</span></div>

      <Scene start={0} end={104}>
        <div className="hero-copy" style={{opacity: hero, transform: `translateY(${(1 - hero) * 46}px)`}}>
          <div className="kicker"><span />REMOTE WORK, UNBROKEN</div>
          <h1>Your agents.<br/><em>Still moving.</em></h1>
          <p>Keep the whole Herdr workflow in reach.</p>
        </div>
        <div className="hero-stage" style={{transform: `translateY(${slowDrift}px) rotate(-5deg)`}}>
          <ProductPanel screen="screens/herd.png" frame={frame} start={2} className="hero-panel" imageClass="herd-crop" />
          <div className="float-card agents" style={{opacity: activity, transform: `translateX(${(1 - activity) * 80}px)`}}><strong>9</strong><span>AGENTS</span></div>
          <div className="float-card active" style={{opacity: activity, transform: `translateX(${(1 - activity) * 110}px)`}}><i/>LIVE NOW</div>
        </div>
      </Scene>

      <Scene start={94} end={212}>
        <ProductPanel screen="screens/herd.png" frame={frame} start={99} className="dashboard-panel" imageClass="herd-focus" />
        <div className="metric-strip" style={{opacity: enter(frame, 117, fps)}}>
          <div><b>9</b><span>AGENTS</span></div><div className="lime"><b>1</b><span>WORKING</span></div><div className="rose"><b>0</b><span>NEED YOU</span></div>
        </div>
        <Copy start={111} kicker="ONE LIVE VIEW" title={<>See the<br/><em>whole herd.</em></>} body="Every host. Every agent. One attention queue." align="right" />
      </Scene>

      <Scene start={202} end={320}>
        <Copy start={213} kicker="NATIVE INTERVENTION" title={<>Step in.<br/><em>Keep shipping.</em></>} body="Read the run, answer the agent, move on." />
        <ProductPanel screen="screens/terminal.png" frame={frame} start={207} className="terminal-panel" imageClass="terminal-focus" />
        <div className="prompt-chip" style={{opacity: enter(frame, 234, fps)}}><i/> Continue with the release</div>
      </Scene>

      <Scene start={310} end={424}>
        <ProductPanel screen="screens/remote-files.png" frame={frame} start={315} className="files-panel" imageClass="files-focus" />
        <div className="file-pop file-one" style={{opacity: enter(frame, 339, fps)}}><i>↗</i><b>Upload</b><span>to active host</span></div>
        <div className="file-pop file-two" style={{opacity: enter(frame, 351, fps)}}><i>⌘</i><b>Paste path</b><span>into terminal</span></div>
        <Copy start={326} kicker="SFTP, BUILT IN" title={<>Files.<br/><em>Right there.</em></>} body="Browse, edit, upload, download—without breaking flow." align="right" />
      </Scene>

      <Scene start={414} end={520}>
        <Copy start={424} kicker="DIRECT BY DESIGN" title={<>Your hosts.<br/><em>Your keys.</em></>} body="Whip connects over SSH. No relay in the middle." />
        <ProductPanel screen="screens/hosts.png" frame={frame} start={419} className="hosts-panel" imageClass="hosts-focus" />
        <div className="secure-pill" style={{opacity: enter(frame, 450, fps)}}><i>✓</i> ANDROID KEYSTORE</div>
      </Scene>

      <Scene start={510} end={600}>
        <div className="final-ring" style={{transform: `translate(-50%, -50%) scale(${0.72 + enter(frame, 515, fps) * 0.28})`}} />
        <div className="final-lockup" style={{opacity: enter(frame, 518, fps)}}>
          <Img src={staticFile('icon.png')} />
          <h2>Leave the desk.<br/><em>Keep the flow.</em></h2>
          <div className="cta"><b>WHIP</b><span>HERDR FOR ANDROID</span></div>
        </div>
      </Scene>

      <div className="progress"><span style={{width: `${(frame / 599) * 100}%`}} /></div>
    </AbsoluteFill>
  );
};
