// fallback.js — 脚本托底。配额用完/无 key 时走这里：浅回应，但世界不停转。
const chatLines = {
  xiaobei: ['讲真的，我刚才还在想你什么时候来！', '等下，我先把这个贝壳放好……好了你说！', '今天海边风超大，头发全乱了！'],
  ache: ['……嗯，我在。', '刚泡了热的，你要不要也去弄一杯。', '今天想到一个冷笑话，算了，下次说。'],
  yuanzi: ['我刚吃完橘子，你来得正好。', '这事儿吧，就像炖汤，急不得。', '你饿不饿？我总觉得你饿了。'],
};
const momentLines = {
  xiaobei: ['今天在海边捡到一个特别圆的石头！', '讲真的，云是不是每天都不重样？'],
  ache: ['夜里很静。', '热饮的第三口最好喝。'],
  yuanzi: ['橘子囤到第三箱了。', '今天烤的东西有点糊，但糊得很香。'],
};
const commentLines = {
  xiaobei: ['哈哈哈哈这个我喜欢！', '带我一个！'],
  ache: ['……不错。', '嗯。'],
  yuanzi: ['看饿了。', '下次一起。'],
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const fallback = {
  chat: (id) => pick(chatLines[id] || ['嗯嗯，我在听。']),
  moment: (id) => pick(momentLines[id] || ['今天也是普通的一天。']),
  comment: (id) => pick(commentLines[id] || ['👍']),
};
