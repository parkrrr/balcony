const ADJECTIVES = [
  "Velvet", "Golden", "Quiet", "Lively", "Curious", "Sleepy", "Plucky", "Jolly",
  "Dapper", "Witty", "Cosmic", "Mellow", "Brave", "Sunny", "Swift", "Cozy",
  "Gentle", "Fancy", "Breezy", "Snappy", "Humble", "Lucky", "Zesty", "Crimson",
];

const ANIMALS = [
  "Otter", "Fox", "Owl", "Panda", "Heron", "Badger", "Lynx", "Moose",
  "Puffin", "Koala", "Gecko", "Walrus", "Raccoon", "Falcon", "Tapir", "Yak",
  "Ferret", "Beaver", "Lemur", "Narwhal", "Alpaca", "Hedgehog", "Toucan", "Bison",
];

const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/** A friendly default for people who don't want to pick a name, e.g. "Velvet Owl". */
export function randomName(): string {
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}
