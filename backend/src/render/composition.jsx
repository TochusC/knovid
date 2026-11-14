import React, {useLayoutEffect, useMemo, useRef} from 'react';
import {Composition, cancelRender, registerRoot, useCurrentFrame} from 'remotion';
import {compile, paint} from './paint.mjs';

function Scene(input) {
  const canvas = useRef(null);
  const frame = useCurrentFrame();
  const scene = useMemo(() => compile(input.code), [input.code]);
  useLayoutEffect(() => {
    try {
      paint(canvas.current, input, frame, scene);
    } catch (error) {
      cancelRender(error);
    }
  }, [frame, input, scene]);
  return <canvas ref={canvas} width={input.width} height={input.height}/>;
}

const meta = ({props}) => ({
  width: props.width, height: props.height, fps: props.fps, durationInFrames: props.durationFrames,
});

function Root() {
  return <Composition id="KnoVidScene" component={Scene} width={640} height={360} fps={25}
    durationInFrames={40} defaultProps={{}} calculateMetadata={meta}/>;
}

registerRoot(Root);
