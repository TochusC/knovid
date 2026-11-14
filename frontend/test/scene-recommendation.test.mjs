import assert from 'node:assert/strict';
import test from 'node:test';
import {recommendSceneCount} from '../src/lib/scene-recommendation.ts';

const recommendTopic = topic => recommendSceneCount({inputType: 'topic', topic, hasPaper: false});

test('scene recommendations reflect the scope of a topic in Chinese and English', () => {
  assert.equal(recommendTopic('为什么行星靠近太阳时跑得更快？'), 3);
  assert.equal(recommendTopic('Why do planets move faster near the Sun?'), 3);
  assert.ok(recommendTopic('从太阳系展开：行星为什么绕太阳公转？轨道上的速度为什么不同？比较近日点和远日点，画出相同时间扫过的面积。') > 3);
  assert.ok(recommendTopic('How does a DNS request travel? Explain recursive and iterative resolution; compare a fresh answer with a cache hit; show what changes when a TTL expires; then explain DNSSEC validation.') > 3);
  assert.equal(recommendTopic('比较不同的实验条件。'.repeat(80)), 32);
});

test('empty inputs, links and paper fallbacks are handled separately', () => {
  assert.equal(recommendTopic('  '), undefined);
  assert.equal(recommendTopic('https://example.com/' + 'long'.repeat(64)), undefined);
  assert.equal(recommendTopic('为什么海水是咸的？ https://example.com/' + 'long'.repeat(64)), 3);
  assert.equal(recommendSceneCount({inputType: 'paper', topic: 'previous draft', hasPaper: false}), undefined);
  assert.equal(recommendSceneCount({inputType: 'paper', topic: '', hasPaper: true}), 8);
});
