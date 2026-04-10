class InventoryService
  LOW_STOCK_THRESHOLD = 5

  def self.check_stock(book)
    {
      book_id: book.id,
      title: book.title,
      stock_count: book.stock_count,
      in_stock: book.in_stock?,
      low_stock: book.stock_count <= LOW_STOCK_THRESHOLD
    }
  end

  def self.reserve(book, quantity)
    book.reserve_stock!(quantity)
  end

  def self.low_stock_books
    Book.where('stock_count > 0 AND stock_count <= ?', LOW_STOCK_THRESHOLD)
  end

  def self.out_of_stock_books
    Book.where(stock_count: 0)
  end
end
