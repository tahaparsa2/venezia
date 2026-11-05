const app = document.querySelector('#app');
app.innerHTML = '<h1>Shopping</h1><input id="t" aria-label="Item"><button id="add">Add</button><ul id="l"></ul><img src="./logo.svg" alt="logo" width="40" height="40">';
document.querySelector('#add').addEventListener('click', () => {
  const item = document.createElement('li');
  item.textContent = document.querySelector('#t').value;
  document.querySelector('#l').append(item);
});
