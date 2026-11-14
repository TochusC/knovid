import { useState } from "react";
import { ArrowUpRight, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import "./creation-launchpad.css";

const prompts = [
  {
    label: "声音的秘密",
    value:
      "用直观动画解释两列声波如何叠加，以及相位相反时为什么会相互抵消。讲给没有物理基础的人听。",
  },
  {
    label: "天空的颜色",
    value:
      "为什么白天的天空是蓝色的，日落时却变成红色？用光的散射动画讲给好奇的普通观众听。",
  },
  {
    label: "AI 如何学习",
    value:
      "用识别手写数字的例子，直观解释神经网络如何从数据中学习，让第一次接触 AI 的人也能理解。",
  },
];

export function CreationLaunchpad({
  onEnter,
  onLogin,
  onDemo,
  accountLabel,
}: {
  onEnter: (topic?: string) => void;
  onLogin: () => void;
  onDemo: () => void;
  accountLabel?: string;
}) {
  const [topic, setTopic] = useState("");
  return (
    <div className="creation-launchpad">
      <div className="launchpad-intro">
        <span className="launchpad-index">
          <b>03</b> 下一部作品
        </span>
        <h2 id="landing-chapter-2">
          轮到你的
          <br />
          <span>好奇心。</span>
        </h2>
        <p>
          写下一个值得讲清楚的问题。
          <br />
          从这里，开始你的知识影片。
        </p>
        <button type="button" className="launchpad-demo" onClick={onDemo}>
          <span>
            <Play size={10} fill="currentColor" />
          </span>{" "}
          看一支样片
        </button>
      </div>
      <form
        className="launchpad-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onEnter(topic.trim() || undefined);
        }}
      >
        <div className="launchpad-writing-heading">
          <label htmlFor="landing-creation-topic">你想讲清楚什么？</label>
          <span>{String(topic.length).padStart(2, "0")} / 300</span>
        </div>
        <div className="launchpad-writing-space">
          <textarea
            id="landing-creation-topic"
            maxLength={300}
            rows={4}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="比如，天空为什么是蓝色的……"
          />
        </div>
        <div className="launchpad-prompts">
          <span>或从这里开始</span>
          {prompts.map((prompt) => (
            <button
              type="button"
              key={prompt.label}
              onClick={() => setTopic(prompt.value)}
              aria-pressed={topic === prompt.value}
            >
              {prompt.label}
            </button>
          ))}
        </div>
        <Button type="submit" className="launchpad-submit">
          <span>
            {topic.trim() ? "带着这个想法，开始" : "进入工作台，开始创作"}
          </span>
          <i>
            <ArrowUpRight size={24} strokeWidth={1.25} />
          </i>
        </Button>
        <div className="launchpad-afterword">
          <p className="launchpad-free">访客可试用 3 次 · 每条最长 30 秒</p>
          <button type="button" className="launchpad-login" onClick={onLogin}>
            {accountLabel ? "我的账户" : "登录账号"}
            <ArrowUpRight size={11} />
          </button>
        </div>
      </form>
    </div>
  );
}
